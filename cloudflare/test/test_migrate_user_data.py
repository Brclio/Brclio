#!/usr/bin/env python3
"""Offline GitHub API model: no credentials or live data are accessed."""
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.parse

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "migrate-user-data.py"
spec = importlib.util.spec_from_file_location("brclio_data_migration", SCRIPT)
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)


def record(value):
    return json.dumps(value, ensure_ascii=False, indent=4).encode("utf-8") + b"\n\n"


def initial_user():
    return {
        "users/_index.json": record({"version": 1, "usernames": {"alice": "u-1"}, "emails": {"alice@example.test": "u-1"}, "google": {}, "devices": {}, "unknown": {"keep": True}}),
        "users/u-1/profile.json": record({"version": 1, "id": "u-1", "username": "Alice", "email": "alice@example.test", "nickname": "中文昵称"}),
        "users/u-1/credentials.json": record({"version": 1, "passwordPlaintext": "do-not-print-secret", "password": {"hash": "unchanged"}, "sessions": {}, "future": {"keep": True}}),
        "users/u-1/data.json": record({"version": 1, "preferences": {"theme": "dark"}, "unknown": [1, 2]}),
        "users/u-1/assets/original.bin": bytes(range(256)) + b"\x00\xffunchanged",
        "config/update-proxy.json": record({"token": "private-proxy-token", "enabled": True}),
    }


class FakeGitHub:
    head = m.GitHub.head
    blob = m.GitHub.blob
    put_blob = m.GitHub.put_blob

    def __init__(self, repository, files=None, intercept=None):
        self.repository = repository
        self.private = True
        self.branch = "main"
        self.calls = []
        self.refs = {}
        self.blobs = {}
        self.trees = {}
        self.commits = {}
        self.intercept = intercept
        self.truncated = False
        entries = {}
        for path, content in (files or {}).items():
            if isinstance(content, str):
                content = content.encode()
            blob_sha = m.git_blob_sha(content)
            self.blobs[blob_sha] = content
            entries[path] = {"path": path, "type": "blob", "mode": "100644", "sha": blob_sha, "size": len(content)}
        tree = self.make_tree(entries)
        self.current_head = self.make_commit(tree, [], "initial " + repository)

    def make_tree(self, entries):
        entries = {path: copy.deepcopy(entry) for path, entry in entries.items() if entry["type"] != "tree"}
        tree_sha = hashlib.sha1(m.canonical_json(entries)).hexdigest()
        self.trees[tree_sha] = entries
        return tree_sha

    def make_commit(self, tree, parents, message):
        value = {"tree": {"sha": tree}, "parents": parents, "message": message}
        commit_sha = hashlib.sha1(m.canonical_json(value)).hexdigest()
        self.commits[commit_sha] = value
        return commit_sha

    def current(self):
        return self.trees[self.commits[self.current_head]["tree"]["sha"]]

    def content(self, path):
        return self.blobs[self.current()[path]["sha"]]

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if self.intercept:
            result = self.intercept(self, method, path, body)
            if result is not None:
                return result
        parsed = urllib.parse.urlsplit(path)
        route = parsed.path
        if method == "GET" and not route:
            return {"private": self.private, "default_branch": self.branch}
        if method == "GET" and route == "/git/ref/heads/" + self.branch:
            return {"object": {"sha": self.current_head, "type": "commit"}}
        if method == "GET" and route.startswith("/git/commits/"):
            return copy.deepcopy(self.commits[route.rsplit("/", 1)[1]])
        if method == "GET" and route.startswith("/git/trees/"):
            tree_sha = route.rsplit("/", 1)[1]
            entries = copy.deepcopy(self.trees[tree_sha])
            directories = set()
            for path in entries:
                parts = path.split("/")
                directories.update("/".join(parts[:depth]) for depth in range(1, len(parts)))
            for directory in directories:
                entries[directory] = {"path": directory, "type": "tree", "mode": "040000", "sha": hashlib.sha1(directory.encode()).hexdigest()}
            return {"sha": tree_sha, "tree": list(entries.values()), "truncated": self.truncated}
        if method == "GET" and route.startswith("/git/blobs/"):
            blob_sha = route.rsplit("/", 1)[1]
            content = self.blobs[blob_sha]
            return {"sha": blob_sha, "size": len(content), "encoding": "base64", "content": base64.b64encode(content).decode()}
        if method == "POST" and route == "/git/blobs":
            content = base64.b64decode(body["content"], validate=True)
            blob_sha = m.git_blob_sha(content)
            self.blobs[blob_sha] = content
            return {"sha": blob_sha}
        if method == "POST" and route == "/git/refs":
            if body["ref"] in self.refs:
                raise m.MigrationError("GitHub POST failed with HTTP 422; no automatic retry")
            self.refs[body["ref"]] = body["sha"]
            return {"ref": body["ref"], "object": {"sha": body["sha"]}}
        if method == "POST" and route == "/git/trees":
            entries = copy.deepcopy(self.trees[body["base_tree"]])
            for entry in body["tree"]:
                if entry["type"] == "blob":
                    if entry["sha"] not in self.blobs:
                        raise AssertionError("Destination blob must exist before creating the tree")
                entries[entry["path"]] = {**entry, "size": len(self.blobs[entry["sha"]])}
            return {"sha": self.make_tree(entries)}
        if method == "POST" and route == "/git/commits":
            return {"sha": self.make_commit(body["tree"], body["parents"], body["message"])}
        if method == "PATCH" and route == "/git/refs/heads/" + self.branch:
            if body["force"] is not False:
                raise AssertionError("Migration must not force update a branch")
            commit = self.commits[body["sha"]]
            if commit["parents"] != [self.current_head]:
                raise m.MigrationError("GitHub PATCH failed with HTTP 422; no automatic retry")
            self.current_head = body["sha"]
            return {"object": {"sha": self.current_head}}
        raise AssertionError("Unexpected fake API request")


class MigrationTests(unittest.TestCase):
    def pair(self, source_files=None, target_files=None):
        return (FakeGitHub("test/source", initial_user() if source_files is None else source_files),
                FakeGitHub("test/target", {"protocol.json": record({"version": 1}), "README.md": b"keep docs\n"} if target_files is None else target_files))

    def apply(self, source, target, plan=None):
        plan = plan or m.create_plan(source, target)
        return m.apply_plan(source, target, plan, writers_frozen=True, source_head=plan.source.head, target_head=plan.target.head)

    def test_live_client_accepts_only_installation_tokens_without_personal_token_fallback(self):
        for value in (None, "", "github_pat_should-never-work", "ghp_should-never-work", "ghs_short", "ghs_" + "a" * 40 + "\n"):
            with self.assertRaises(m.MigrationError):
                m.GitHub("test/repo", value)
        m.GitHub("test/repo", "ghs_" + "a" * 40)
        m.GitHub("test/repo", "ghs_1234_" + "a" * 300 + ".payload.signature-with_dash")

    def test_default_plan_is_read_only_and_redacts_record_values(self):
        source, target = self.pair()
        before_source, before_target = source.current_head, target.current_head
        plan = m.create_plan(source, target)
        self.assertTrue(all(method == "GET" for api in (source, target) for method, _, _ in api.calls))
        self.assertEqual((before_source, before_target), (source.current_head, target.current_head))
        self.assertEqual(plan.counts, {"users": 1, "sourceBlobs": 5, "derivedBrclioData": 1, "alreadyPresent": 0, "newFiles": 6})
        summary = json.dumps(plan.public())
        for secret in ("do-not-print-secret", "alice@example.test", "private-proxy-token", "中文昵称", "u-1"):
            self.assertNotIn(secret, summary)

    def test_apply_preserves_all_user_bytes_source_and_existing_target_and_creates_backup_manifest(self):
        source, target = self.pair()
        before_source, before_target = source.current_head, target.current_head
        original = {path: source.content(path) for path in source.current()}
        result = self.apply(source, target)
        self.assertTrue(result["verified"])
        self.assertEqual(source.current_head, before_source)
        self.assertTrue(all(method == "GET" for method, _, _ in source.calls))
        self.assertEqual(target.refs[result["backupRef"]], before_target)
        for path, content in original.items():
            if not path.startswith("users/"):
                continue
            self.assertEqual(target.content(path), content, path)
            self.assertEqual(target.current()[path]["sha"], source.current()[path]["sha"])
        self.assertEqual(target.content("users/u-1/apps/brclio/data.json"), original["users/u-1/data.json"])
        self.assertEqual(target.content("README.md"), b"keep docs\n")
        self.assertEqual(sum(method == "POST" and path == "/git/trees" for method, path, _ in target.calls), 1)
        self.assertEqual(sum(method == "POST" and path == "/git/commits" for method, path, _ in target.calls), 1)
        self.assertEqual(sum(method == "PATCH" for method, _, _ in target.calls), 1)
        manifest = json.loads(target.content(result["manifestPath"]))
        self.assertEqual(manifest["source"]["head"], before_source)
        self.assertEqual(manifest["targetBefore"]["head"], before_target)
        self.assertEqual(manifest["counts"], result["counts"])
        self.assertNotIn("do-not-print-secret", json.dumps(manifest))
        self.assertTrue(all("sha" in entry for entry in manifest["files"]))

    def test_global_config_and_resources_are_never_read_or_copied_and_existing_target_files_are_preserved(self):
        source_files = {**initial_user(), "config/future.json": b"not user JSON", "public/banner.bin": b"program resource"}
        for existing_config in (None, b"existing target config bytes must remain untouched"):
            with self.subTest(existing_target_config=existing_config is not None):
                target_files = {"protocol.json": record({"version": 1}), "README.md": b"keep docs\n"}
                if existing_config is not None:
                    target_files["config/update-proxy.json"] = existing_config
                source, target = self.pair(source_files=source_files, target_files=target_files)
                before_source = source.current_head
                plan = m.create_plan(source, target)
                self.assertTrue(all(path.startswith("users/") for path in plan.changes))
                self.apply(source, target, plan)
                self.assertEqual(source.current_head, before_source)
                for path in ("config/update-proxy.json", "config/future.json", "public/banner.bin"):
                    self.assertEqual(source.content(path), source_files[path])
                    source_blob_read = "/git/blobs/" + source.current()[path]["sha"]
                    self.assertFalse(any(method == "GET" and route == source_blob_read for method, route, _ in source.calls))
                self.assertNotIn("config/future.json", target.current())
                self.assertNotIn("public/banner.bin", target.current())
                if existing_config is None:
                    self.assertNotIn("config/update-proxy.json", target.current())
                else:
                    self.assertEqual(target.content("config/update-proxy.json"), existing_config)
                self.assertEqual(target.content("users/u-1/assets/original.bin"), source_files["users/u-1/assets/original.bin"])

    def test_apply_requires_freeze_and_both_exact_reviewed_heads_before_any_write(self):
        for freeze, source_pin, target_pin in [(False, True, True), (True, False, True), (True, True, False)]:
            source, target = self.pair()
            plan = m.create_plan(source, target)
            with self.assertRaises(m.MigrationError):
                m.apply_plan(source, target, plan, writers_frozen=freeze,
                             source_head=plan.source.head if source_pin else "0" * 40,
                             target_head=plan.target.head if target_pin else None)
            self.assertTrue(all(method == "GET" for method, _, _ in target.calls))
        source, target = self.pair()
        with self.assertRaises(m.MigrationError):
            m.create_plan(source, target, source_head="0" * 40)

    def test_public_repositories_and_truncated_trees_fail_closed(self):
        for side in (0, 1):
            source, target = self.pair()
            (source, target)[side].private = False
            with self.assertRaisesRegex(m.MigrationError, "private"):
                m.create_plan(source, target)
            self.assertTrue(all(method == "GET" for method, _, _ in target.calls))
            source, target = self.pair()
            (source, target)[side].truncated = True
            with self.assertRaisesRegex(m.MigrationError, "truncated"):
                m.create_plan(source, target)

    def test_any_different_destination_source_path_stops_before_write(self):
        for path in initial_user():
            if not path.startswith("users/"):
                continue
            source, target = self.pair(target_files={**initial_user(), path: initial_user()[path] + b" "})
            # Both representations remain JSON-valid when applicable, but their
            # original bytes differ. No normalization or overwrite is allowed.
            with self.assertRaises(m.MigrationError):
                m.create_plan(source, target)
            self.assertTrue(all(method == "GET" for method, _, _ in target.calls))

    def test_existing_same_bytes_with_a_different_git_mode_is_a_conflict(self):
        source, target = self.pair(target_files=initial_user())
        tree = copy.deepcopy(target.current())
        tree["users/u-1/assets/original.bin"]["mode"] = "100755"
        target.current_head = target.make_commit(target.make_tree(tree), [target.current_head], "different mode")
        with self.assertRaisesRegex(m.MigrationError, "Target data conflict"):
            m.create_plan(source, target)
        self.assertTrue(all(method == "GET" for method, _, _ in target.calls))

    def test_existing_app_data_is_preserved_and_existing_source_app_data_wins_over_derivation(self):
        files = initial_user()
        app = "users/u-1/apps/brclio/data.json"
        target_files = {**files, app: record({**json.loads(files["users/u-1/data.json"]), "revision": 4})}
        source, target = self.pair(target_files=target_files)
        plan = m.create_plan(source, target)
        self.assertEqual(plan.counts["derivedBrclioData"], 0)
        self.assertEqual(plan.counts["newFiles"], 0)
        self.apply(source, target, plan)
        self.assertEqual(target.content(app), target_files[app])
        source, target = self.pair(source_files=target_files)
        plan = m.create_plan(source, target)
        self.assertEqual(plan.counts["derivedBrclioData"], 0)
        self.apply(source, target, plan)
        self.assertEqual(target.content(app), target_files[app])

    def test_legacy_and_namespaced_data_must_match_all_business_fields(self):
        app = "users/u-1/apps/brclio/data.json"
        for changed in ({"preferences": {"theme": "light"}}, {"unknown": [1, 2, 3]}, {"unknown": [True, 2]}):
            files = initial_user()
            current = {**json.loads(files["users/u-1/data.json"]), **changed, "revision": 2}
            for side in ("source", "target"):
                source, target = self.pair(source_files={**files, app: record(current)} if side == "source" else files,
                                           target_files={**files, app: record(current)} if side == "target" else None)
                with self.assertRaisesRegex(m.MigrationError, "Legacy and namespaced"):
                    m.create_plan(source, target)
                self.assertTrue(all(method == "GET" for method, _, _ in target.calls))

    def test_bad_checksums_sizes_json_versions_and_identity_references_stop(self):
        for bad in (b"null", b"{broken", b'{"version":2}', b'{"version":true}', b'{"version":1,"id":"wrong"}', b'{"id":"u-1","id":"u-1"}'):
            files = {**initial_user(), "users/u-1/profile.json": bad}
            source, target = self.pair(source_files=files)
            with self.assertRaises(m.MigrationError):
                m.create_plan(source, target)
        for broken in ({"usernames": {"alice": "missing"}}, {"devices": {"request": {"userId": "missing"}}}):
            files = initial_user()
            index = json.loads(files["users/_index.json"])
            index.update(broken)
            files["users/_index.json"] = record(index)
            source, target = self.pair(source_files=files)
            with self.assertRaises(m.MigrationError):
                m.create_plan(source, target)
        for error in ("checksum", "size"):
            source, target = self.pair()
            def intercept(api, method, path, body):
                if method == "GET" and path.startswith("/git/blobs/"):
                    blob_sha = path.rsplit("/", 1)[1]
                    content = api.blobs[blob_sha]
                    return {"sha": blob_sha, "size": len(content) + (error == "size"), "encoding": "base64", "content": base64.b64encode(content if error == "size" else b"tampered").decode()}
            source.intercept = intercept
            with self.assertRaises(m.MigrationError):
                m.create_plan(source, target)

    def test_missing_credentials_and_unsafe_paths_are_not_silently_omitted(self):
        files = initial_user()
        files.pop("users/u-1/credentials.json")
        source, target = self.pair(source_files=files)
        with self.assertRaises(m.MigrationError):
            m.create_plan(source, target)
        source, target = self.pair(source_files={**initial_user(), "users/u-1/../escape.bin": b"data"})
        with self.assertRaises(m.MigrationError):
            m.create_plan(source, target)

    def test_source_change_before_commit_stops_with_only_backup_and_unpublished_objects(self):
        source, target = self.pair()
        plan = m.create_plan(source, target)
        before_target = target.current_head
        checks = 0
        def advance(api, method, path, body):
            nonlocal checks
            if method == "GET" and path == "/git/ref/heads/main":
                checks += 1
                if checks == 2:
                    api.current_head = api.make_commit(api.commits[api.current_head]["tree"]["sha"], [api.current_head], "external source change")
        source.intercept = advance
        with self.assertRaisesRegex(m.MigrationError, "Source head changed"):
            self.apply(source, target, plan)
        self.assertEqual(target.current_head, before_target)
        self.assertEqual(len(target.refs), 1)
        self.assertFalse(any(method == "POST" and path == "/git/commits" for method, path, _ in target.calls))
        self.assertFalse(any(method == "PATCH" for method, _, _ in target.calls))

    def test_non_force_ref_conflict_and_uncertain_network_failure_never_retry(self):
        for uncertain in (False, True):
            source, target = self.pair()
            before_target = target.current_head
            def reject(api, method, path, body):
                if method == "PATCH":
                    self.assertFalse(body["force"])
                    if uncertain:
                        # The API can accept a ref and lose its response. The
                        # client must not repeat the migration in that case.
                        api.current_head = body["sha"]
                    raise m.MigrationError("simulated uncertain network" if uncertain else "GitHub PATCH failed with HTTP 422; no automatic retry")
            target.intercept = reject
            with self.assertRaises(m.MigrationError):
                self.apply(source, target)
            self.assertEqual(sum(method == "PATCH" for method, _, _ in target.calls), 1)
            self.assertEqual(sum(method == "POST" and path == "/git/commits" for method, path, _ in target.calls), 1)
            self.assertEqual(len(target.refs), 1)
            self.assertEqual(target.refs[next(iter(target.refs))], before_target)

    def test_post_publish_tree_verification_detects_corruption_without_retry(self):
        source, target = self.pair()
        changed = False
        def alter(api, method, path, body):
            nonlocal changed
            if method == "PATCH":
                changed = True
            if changed and method == "GET" and path.startswith("/git/trees/"):
                api.truncated = True
        target.intercept = alter
        with self.assertRaisesRegex(m.MigrationError, "truncated"):
            self.apply(source, target)
        self.assertEqual(sum(method == "PATCH" for method, _, _ in target.calls), 1)

    def test_cli_uses_environment_tokens_and_default_is_plan_without_secret_output(self):
        source, target = self.pair()
        def api(repository, token):
            self.assertEqual(token, "source-only-secret" if repository == "test/source" else "target-only-secret")
            return source if repository == "test/source" else target
        out, err = io.StringIO(), io.StringIO()
        with patch.object(m, "GitHub", side_effect=api), patch.dict(os.environ, {"GITHUB_INSTALLATION_TOKEN": "target-only-secret", "SOURCE_GITHUB_INSTALLATION_TOKEN": "source-only-secret"}), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(m.main(["--source", "test/source", "--target", "test/target"]), 0)
        self.assertEqual(json.loads(out.getvalue())["operation"], "plan")
        self.assertEqual(err.getvalue(), "")
        self.assertNotIn("secret", out.getvalue())
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(m.main(["--apply"]), 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("writers-frozen", err.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
