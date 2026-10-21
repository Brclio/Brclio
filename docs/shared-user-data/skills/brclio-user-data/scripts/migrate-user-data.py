#!/usr/bin/env python3
"""Plan or perform a byte-preserving, one-commit private GitHub data migration.

Defaults to a read-only plan. Short-lived GitHub App installation tokens are read only from
GITHUB_INSTALLATION_TOKEN and optional SOURCE_GITHUB_INSTALLATION_TOKEN. Never pass a token on the command line. Apply requires a
confirmed writer freeze plus the exact source and target heads from the plan.
Only users/** is migrated; global program configuration and resources stay in
the source ProgramRepo. The source repository is never modified. A failed or uncertain ref update is
never retried automatically; inspect the target head before planning again.
"""
from __future__ import annotations

import argparse
import base64
import binascii
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


class MigrationError(Exception):
    """An actionable failure whose message contains no user records or secrets."""


SHA = re.compile(r"^[0-9a-f]{40}$")
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
USER_ID = re.compile(r"^[A-Za-z0-9-]+$")
MAX_BLOB_BYTES = 100 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise MigrationError(message)


def sha(value):
    require(isinstance(value, str) and SHA.fullmatch(value), "Invalid Git object SHA")
    return value


def git_blob_sha(content):
    return hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()


def canonical_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate key in JSON record")
        result[key] = value
    return result


def parse_record(content):
    try:
        value = json.loads(content.decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(MigrationError("Non-finite JSON number")))
        def finite(item):
            if isinstance(item, float):
                require(math.isfinite(item), "Non-finite JSON number")
            elif isinstance(item, dict):
                for child in item.values():
                    finite(child)
            elif isinstance(item, list):
                for child in item:
                    finite(child)
        finite(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise MigrationError("Invalid UTF-8 JSON record") from None


def object_record(content, require_version=False):
    value = parse_record(content)
    require(isinstance(value, dict), "Account record must be a JSON object")
    if require_version or "version" in value:
        require(type(value.get("version")) is int and value["version"] == 1, "Unsupported account record version")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    def __init__(self, repository, token):
        require(REPO.fullmatch(repository) is not None, "Invalid repository name")
        require(isinstance(token, str) and len(token) <= 16384 and re.fullmatch(r"ghs_[A-Za-z0-9.\-_]{36,}", token), "A short-lived GitHub App installation token environment variable is required")
        self.repository = repository
        self._token = token
        self._opener = urllib.request.build_opener(NoRedirect)

    def request(self, method, path, body=None):
        headers = {"Authorization": "Bearer " + self._token,
                   "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "User-Agent": "Brclio-Private-Data-Migration"}
        payload = None
        if body is not None:
            payload = json.dumps(body, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request("https://api.github.com/repos/" + self.repository + path,
                                         data=payload, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=45) as response:
                raw = response.read(150 * 1024 * 1024 + 1)
                require(len(raw) <= 150 * 1024 * 1024, "GitHub response is too large")
                value = json.loads(raw)
                require(isinstance(value, dict), "Invalid GitHub API response")
                return value
        except urllib.error.HTTPError as error:
            error.close()
            raise MigrationError(f"GitHub {method} failed with HTTP {error.code}; no automatic retry") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise MigrationError(f"GitHub {method} outcome uncertain; inspect repository heads before retrying") from None
        except (ValueError, UnicodeError):
            raise MigrationError("Invalid GitHub API JSON response") from None

    def head(self, branch):
        reference = self.request("GET", "/git/ref/heads/" + urllib.parse.quote(branch, safe=""))
        require(isinstance(reference.get("object"), dict) and reference["object"].get("type", "commit") == "commit", "Invalid branch reference")
        return sha(reference["object"].get("sha"))

    def blob(self, expected_sha, expected_size=None):
        file = self.request("GET", "/git/blobs/" + sha(expected_sha))
        require(file.get("sha") == expected_sha and file.get("encoding") == "base64" and isinstance(file.get("content"), str), "Invalid Git blob response")
        require(type(file.get("size")) is int and 0 <= file["size"] <= MAX_BLOB_BYTES, "Invalid Git blob size")
        try:
            content = base64.b64decode(re.sub(r"\s", "", file["content"]), validate=True)
        except (binascii.Error, ValueError):
            raise MigrationError("Invalid Git blob encoding") from None
        require(len(content) == file["size"] and (expected_size is None or len(content) == expected_size), "Git blob size mismatch")
        require(git_blob_sha(content) == expected_sha, "Git blob checksum mismatch")
        return content

    def put_blob(self, content):
        expected = git_blob_sha(content)
        result = self.request("POST", "/git/blobs", {"encoding": "base64", "content": base64.b64encode(content).decode("ascii")})
        require(result.get("sha") == expected, "Created Git blob checksum mismatch")
        return expected


@dataclass
class Snapshot:
    repository: str
    branch: str
    head: str
    tree: str
    entries: dict

    def public(self):
        return {"repository": self.repository, "branch": self.branch, "head": self.head, "tree": self.tree}


def safe_path(path):
    return (isinstance(path, str) and path and not path.startswith("/") and "\\" not in path
            and not any(ord(char) < 32 or ord(char) == 127 for char in path)
            and all(part and part not in (".", "..", ".git") for part in path.split("/")))


def read_tree(api, tree_sha):
    tree = api.request("GET", "/git/trees/" + sha(tree_sha) + "?recursive=1")
    require(tree.get("sha", tree_sha) == tree_sha and tree.get("truncated") is False and isinstance(tree.get("tree"), list), "Incomplete or truncated repository tree")
    entries = {}
    for entry in tree["tree"]:
        require(isinstance(entry, dict) and safe_path(entry.get("path")), "Unsafe Git tree path")
        require(entry["path"] not in entries, "Duplicate Git tree path")
        require(entry.get("type") in ("blob", "tree", "commit"), "Unsupported Git tree entry")
        sha(entry.get("sha"))
        require(entry.get("mode") in ("100644", "100755", "040000", "120000", "160000"), "Unsupported Git tree mode")
        entries[entry["path"]] = entry
    return entries


def snapshot(api):
    metadata = api.request("GET", "")
    require(metadata.get("private") is True, "Both repositories must be private")
    branch = metadata.get("default_branch")
    require(isinstance(branch, str) and branch, "Repository must have an initialized default branch")
    head = api.head(branch)
    commit = api.request("GET", "/git/commits/" + head)
    require(isinstance(commit.get("tree"), dict), "Invalid commit tree")
    tree = sha(commit["tree"].get("sha"))
    return Snapshot(api.repository, branch, head, tree, read_tree(api, tree))


def selected(path):
    return path.startswith("users/")


def load_records(api, state):
    contents, records, user_ids = {}, {}, set()
    by_sha = {}
    for path, entry in state.entries.items():
        if not selected(path) and path != "protocol.json":
            continue
        if entry["type"] == "tree":
            continue
        require(entry["type"] == "blob" and entry["mode"] in ("100644", "100755"), "User data must contain regular blobs only")
        if path.startswith("users/") and path != "users/_index.json":
            parts = path.split("/")
            require(len(parts) >= 3 and USER_ID.fullmatch(parts[1]), "Invalid user folder layout")
            user_ids.add(parts[1])
        if entry["sha"] not in by_sha:
            by_sha[entry["sha"]] = api.blob(entry["sha"], entry.get("size"))
        content = by_sha[entry["sha"]]
        require(entry.get("size") is None or (type(entry["size"]) is int and entry["size"] == len(content)), "Git tree blob size mismatch")
        contents[path] = content
        if path.endswith(".json"):
            records[path] = parse_record(content)
            if path == "protocol.json":
                object_record(content, require_version=True)
            elif path == "users/_index.json" or re.fullmatch(r"users/[^/]+/(?:profile|credentials|data)\.json", path) or re.fullmatch(r"users/[^/]+/apps/[^/]+/data\.json", path):
                object_record(content)
    if user_ids or "users/_index.json" in contents:
        require("users/_index.json" in contents, "User folders require the shared identity index")
        index = object_record(contents["users/_index.json"])
        for user_id in user_ids:
            profile_path, credentials_path = f"users/{user_id}/profile.json", f"users/{user_id}/credentials.json"
            require(profile_path in contents and credentials_path in contents, "User profile or credentials record is missing")
            profile = object_record(contents[profile_path])
            require(profile.get("id") == user_id, "User profile ID does not match its folder")
            object_record(contents[credentials_path])
        for field in ("usernames", "emails", "google"):
            references = index.get(field, {})
            require(isinstance(references, dict), "Invalid identity index map")
            require(all(isinstance(user_id, str) and user_id in user_ids for user_id in references.values()), "Identity index references a missing user")
        for user_id in user_ids:
            profile = records[f"users/{user_id}/profile.json"]
            for field, key in (("username", "usernames"), ("email", "emails")):
                identifier = profile.get(field)
                if identifier:
                    require(isinstance(identifier, str) and index.get(key, {}).get(identifier.lower()) == user_id, "User identity does not match the shared index")
            provider = records[f"users/{user_id}/credentials.json"].get("googleSub")
            if provider:
                require(isinstance(provider, str) and index.get("google", {}).get(provider) == user_id, "Google identity does not match the shared index")
        devices = index.get("devices", {})
        require(isinstance(devices, dict), "Invalid device index")
        for device in devices.values():
            require(isinstance(device, dict), "Invalid device record")
            require("userId" not in device or (isinstance(device["userId"], str) and device["userId"] in user_ids), "Device index references a missing user")
    return contents, len(user_ids)


@dataclass
class Plan:
    source: Snapshot
    target: Snapshot
    changes: dict
    expected: dict
    contents: dict
    counts: dict

    def public(self):
        digest = hashlib.sha256(canonical_json([{key: value[key] for key in ("path", "sha", "mode", "type")} for _, value in sorted(self.expected.items())])).hexdigest()
        return {"operation": "plan", "source": self.source.public(), "target": self.target.public(), "counts": self.counts, "expectedFilesDigest": digest}


def create_plan(source_api, target_api, source_head=None, target_head=None):
    require(source_api.repository != target_api.repository, "Source and target repositories must differ")
    source, target = snapshot(source_api), snapshot(target_api)
    if source_head:
        require(source.head == source_head, "Source head changed; produce a new plan")
    if target_head:
        require(target.head == target_head, "Target head changed; produce a new plan")
    source_contents, user_count = load_records(source_api, source)
    target_contents, _ = load_records(target_api, target)
    expected = {path: dict(entry) for path, entry in target.entries.items() if entry["type"] != "tree"}
    changes, contents, copied, derived, present = {}, {}, 0, 0, 0
    for path, entry in source.entries.items():
        if not selected(path):
            continue
        require(entry["type"] != "commit", "Unsupported user data submodule")
        if entry["type"] == "tree":
            continue
        copied += 1
        existing = target.entries.get(path)
        if existing:
            require(existing["type"] == "blob" and existing["sha"] == entry["sha"] and existing["mode"] == entry["mode"], "Target data conflict; migration never overwrites differing content")
            present += 1
        else:
            changes[path] = dict(entry)
            contents[path] = source_contents[path]
            expected[path] = dict(entry)
    for path, entry in source.entries.items():
        match = re.fullmatch(r"users/([A-Za-z0-9-]+)/data\.json", path)
        if not match or entry["type"] != "blob":
            continue
        app_path = f"users/{match[1]}/apps/brclio/data.json"
        # If either repository already has both layouts, preserve the file only
        # after proving that no business fields diverged. Whitespace/key order
        # and the new revision counter may differ; preferences and unknown
        # business fields must agree exactly before switching the read path.
        legacy = object_record(source_contents[path])
        legacy_semantics = {key: value for key, value in legacy.items() if key != "revision"}
        for state, data in ((source, source_contents), (target, target_contents)):
            if app_path not in state.entries:
                continue
            require(state.entries[app_path]["type"] == "blob", "Application data path is not a regular blob")
            current = object_record(data[app_path])
            current_semantics = {key: value for key, value in current.items() if key != "revision"}
            require(json.dumps(current_semantics, sort_keys=True, allow_nan=False) == json.dumps(legacy_semantics, sort_keys=True, allow_nan=False), "Legacy and namespaced Brclio data differ; migration stopped")
        if app_path in target.entries or app_path in source.entries:
            continue
        derived += 1
        changes[app_path] = {**entry, "path": app_path}
        contents[app_path] = source_contents[path]
        expected[app_path] = dict(changes[app_path])
    for path in changes:
        parts = path.split("/")
        for depth in range(1, len(parts)):
            ancestor = target.entries.get("/".join(parts[:depth]))
            require(ancestor is None or ancestor["type"] == "tree", "Target directory conflicts with a migration path")
    counts = {"users": user_count, "sourceBlobs": copied, "derivedBrclioData": derived, "alreadyPresent": present, "newFiles": len(changes)}
    return Plan(source, target, changes, expected, contents, counts)


def assert_heads(source_api, target_api, plan):
    require(source_api.head(plan.source.branch) == plan.source.head, "Source head changed; migration stopped without retry")
    require(target_api.head(plan.target.branch) == plan.target.head, "Target head changed; migration stopped without retry")


def verify_tree(api, tree_sha, expected):
    actual = {path: entry for path, entry in read_tree(api, tree_sha).items() if entry["type"] != "tree"}
    require(set(actual) == set(expected), "Migrated tree contains missing or unexpected files")
    require(all(all(actual[path].get(key) == entry.get(key) for key in ("sha", "mode", "type")) for path, entry in expected.items()), "Migrated tree blob checksum or mode mismatch")


def apply_plan(source_api, target_api, plan, *, writers_frozen=False, source_head=None, target_head=None):
    require(writers_frozen, "Apply requires --writers-frozen after all source and target writers are stopped")
    require(source_head == plan.source.head and target_head == plan.target.head, "Apply requires the exact --source-head and --target-head from the plan")
    assert_heads(source_api, target_api, plan)
    migration_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]
    backup_ref = "refs/heads/codex/backups/user-data-migration/" + migration_id
    backup = target_api.request("POST", "/git/refs", {"ref": backup_ref, "sha": plan.target.head})
    require(isinstance(backup.get("object"), dict) and backup["object"].get("sha") == plan.target.head, "Target backup reference verification failed")
    known_blobs = {entry["sha"] for entry in plan.target.entries.values() if entry["type"] == "blob"}
    uploaded = set()
    for path, entry in plan.changes.items():
        if entry["sha"] not in known_blobs and entry["sha"] not in uploaded:
            require(target_api.put_blob(plan.contents[path]) == entry["sha"], "Uploaded data does not match the source blob")
            uploaded.add(entry["sha"])
    manifest_path = "migrations/" + migration_id + ".json"
    require(manifest_path not in plan.target.entries, "Migration manifest already exists")
    manifest = {"version": 1, "migrationId": migration_id, "createdAt": datetime.now(timezone.utc).isoformat(),
                "source": plan.source.public(), "targetBefore": plan.target.public(), "backupRef": backup_ref,
                "counts": plan.counts, "sourceRetained": True,
                "files": [{"path": path, "sha": entry["sha"], "mode": entry["mode"]} for path, entry in sorted(plan.expected.items())]}
    manifest_content = canonical_json(manifest)
    manifest_sha = target_api.put_blob(manifest_content)
    manifest_entry = {"path": manifest_path, "sha": manifest_sha, "mode": "100644", "type": "blob"}
    entries = [dict(entry) for entry in plan.changes.values()] + [manifest_entry]
    tree = target_api.request("POST", "/git/trees", {"base_tree": plan.target.tree,
                             "tree": [{key: entry[key] for key in ("path", "sha", "mode", "type")} for entry in entries]})
    tree_sha = sha(tree.get("sha"))
    expected = {**plan.expected, manifest_path: manifest_entry}
    verify_tree(target_api, tree_sha, expected)
    # Recheck both pins immediately before making the migration commit. An
    # observed source change invalidates the freeze assertion and stops apply.
    assert_heads(source_api, target_api, plan)
    commit = target_api.request("POST", "/git/commits", {"message": "Migrate shared user data; preserve source and exact blob bytes", "tree": tree_sha, "parents": [plan.target.head]})
    commit_sha = sha(commit.get("sha"))
    assert_heads(source_api, target_api, plan)
    updated = target_api.request("PATCH", "/git/refs/heads/" + urllib.parse.quote(plan.target.branch, safe=""), {"sha": commit_sha, "force": False})
    require(isinstance(updated.get("object"), dict) and updated["object"].get("sha") == commit_sha, "Migration ref outcome uncertain; inspect target head before any rerun")
    require(target_api.head(plan.target.branch) == commit_sha, "Target advanced after migration; inspect the published migration commit")
    published = target_api.request("GET", "/git/commits/" + commit_sha)
    require(isinstance(published.get("tree"), dict) and published["tree"].get("sha") == tree_sha, "Published migration tree mismatch")
    verify_tree(target_api, tree_sha, expected)
    # Uploads and destination reads both prove the exact original bytes; the
    # tree verification above also covers all destination files that predated us.
    for blob_sha in uploaded | {manifest_sha}:
        target_api.blob(blob_sha)
    return {"operation": "applied", "source": plan.source.public(), "targetBefore": plan.target.public(),
            "targetHead": commit_sha, "targetTree": tree_sha, "backupRef": backup_ref,
            "manifestPath": manifest_path, "counts": plan.counts, "sourceRetained": True, "verified": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="BrclioData/BrclioData")
    parser.add_argument("--target", default="BrclioData/BrclioUserData")
    parser.add_argument("--apply", action="store_true", help="Publish one migration commit after all checks")
    parser.add_argument("--writers-frozen", action="store_true", help="Assert that every program writing either repository has been stopped")
    parser.add_argument("--source-head", help="Exact source commit SHA reported by the plan")
    parser.add_argument("--target-head", help="Exact target commit SHA reported by the plan")
    args = parser.parse_args(argv)
    try:
        if args.source_head:
            sha(args.source_head)
        if args.target_head:
            sha(args.target_head)
        if args.apply:
            require(args.writers_frozen, "Apply requires --writers-frozen after all source and target writers are stopped")
            require(args.source_head and args.target_head, "Apply requires --source-head and --target-head from a reviewed plan")
        target_api = GitHub(args.target, os.environ.get("GITHUB_INSTALLATION_TOKEN"))
        source_api = GitHub(args.source, os.environ.get("SOURCE_GITHUB_INSTALLATION_TOKEN") or os.environ.get("GITHUB_INSTALLATION_TOKEN"))
        plan = create_plan(source_api, target_api, args.source_head, args.target_head)
        result = apply_plan(source_api, target_api, plan, writers_frozen=args.writers_frozen,
                            source_head=args.source_head, target_head=args.target_head) if args.apply else plan.public()
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except MigrationError as error:
        print(json.dumps({"operation": "stopped", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception:
        # API and record exceptions must never expose request bodies, tokens,
        # passwords, identity keys, proxy configuration or other user values.
        print(json.dumps({"operation": "stopped", "error": "Unexpected migration failure; inspect repository heads before retrying"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
