#!/usr/bin/env python3
"""Read-only, value-redacting structural validation of a private repository clone."""

import argparse
import base64
from collections import Counter
import json
import math
from pathlib import Path
import re
import sys
import uuid


SAFE_ID = re.compile(r"[A-Za-z0-9-]+\Z")
APP_ID = re.compile(r"[a-z][a-z0-9-]{0,47}\Z")
RESERVED = {"users", "apps", "profile", "credentials", "data", "protocol", "identity", "system"}
FORBIDDEN = {"__proto__", "constructor", "prototype"}
MAX_SAFE_INTEGER = 2**53 - 1
JS_TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_SAFE_INTEGER


def uuid_id(value):
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def reject_constant(_):
    raise ValueError("nonfinite JSON number")


def encoded_bytes(value, size):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        return False
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        return len(decoded) == size and base64.urlsafe_b64encode(decoded).decode().rstrip("=") == value
    except (ValueError, TypeError):
        return False


def valid_app_json(value, depth=0):
    if depth > 16:
        return False
    if value is None or type(value) in (str, bool):
        return True
    if type(value) in (int, float):
        try:
            return math.isfinite(value)
        except OverflowError:
            return False
    if isinstance(value, list):
        return len(value) <= 1000 and all(valid_app_json(item, depth + 1) for item in value)
    return isinstance(value, dict) and all(key not in FORBIDDEN and valid_app_json(item, depth + 1) for key, item in value.items())


def js_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def js_integer(value, minimum=0, maximum=MAX_SAFE_INTEGER):
    return js_number(value) and minimum <= value <= maximum and value == math.floor(value)


def duel_names(value):
    return isinstance(value, list) and len(value) == 2 and all(
        isinstance(name, str) and bool(name.strip(JS_TRIM))
        and len(name.encode("utf-16-le", errors="surrogatepass")) // 2 <= 16
        and not re.search(r"[\x00-\x1f\x7f]", name)
        for name in value
    )


def valid_miniapp_data(data):
    """Match the identity service's known duel checks; preserve unknown keys."""
    if not isinstance(data, dict):
        return False
    if "duel" not in data:
        return True
    duel = data["duel"]
    preferences = duel.get("preferences") if isinstance(duel, dict) else None
    if not isinstance(preferences, dict):
        return False
    target = preferences.get("targetScore")
    matches = duel.get("matches")
    if not js_number(target) or target not in (1, 3, 5) or type(preferences.get("haptics")) is not bool or not duel_names(preferences.get("names")) or not isinstance(matches, list) or len(matches) > 20:
        return False
    ids = set()
    for match in matches:
        if not isinstance(match, dict):
            return False
        match_id, winner, scores, best = (match.get(key) for key in ("id", "winner", "scores", "bestMs"))
        if not isinstance(match_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", match_id) or match_id in ids or not js_integer(match.get("at"), 1577836800000) or not js_integer(winner, 0, 1) or not duel_names(match.get("names")) or not isinstance(scores, list) or len(scores) != 2 or any(not js_integer(score, 0, 5) for score in scores):
            return False
        if scores[int(winner)] not in (1, 3, 5) or scores[1 - int(winner)] >= scores[int(winner)] or "bestMs" not in match or not (best is None or js_number(best) and 0 <= best <= 5000):
            return False
        ids.add(match_id)
    return True


class Validator:
    def __init__(self, root, allow_legacy_ids=False):
        self.root = root.resolve()
        self.allow_legacy_ids = allow_legacy_ids
        self.errors = Counter()
        self.counts = Counter()

    def fail(self, category):
        # Do not include filenames containing user IDs, JSON values, or raw errors.
        self.errors[category] += 1

    def read(self, relative, category):
        path = self.root / relative
        try:
            current = path
            while current != self.root:
                if current.is_symlink():
                    self.fail(category + ":symlink-refused")
                    return None
                current = current.parent
            raw = path.read_bytes()
            if len(raw) > 2 * 1024 * 1024:
                self.fail(category + ":record-too-large")
                return None
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=reject_constant)
            if not isinstance(value, dict):
                raise ValueError("record must be an object")
            self.counts["json_records"] += 1
            return value
        except (OSError, UnicodeError, ValueError, RecursionError):
            self.fail(category + ":missing-unreadable-or-invalid-json")
            return None

    def app_record(self, path, app_id):
        category = "application-record"
        record = self.read(path.relative_to(self.root), category)
        if record is None:
            return
        self.counts["application_records"] += 1
        if type(record.get("version")) is not int or record["version"] != 1:
            self.fail(category + ":unsupported-version")
        if app_id == "brclio":
            if not isinstance(record.get("preferences"), dict):
                self.fail(category + ":invalid-brclio-preferences")
            if "revision" in record and not integer(record["revision"]):
                self.fail(category + ":invalid-revision")
        else:
            data = record.get("data")
            if not integer(record.get("revision")) or not isinstance(data, dict):
                self.fail(category + ":invalid-envelope")
            if not valid_app_json(data):
                self.fail(category + ":invalid-data-structure")
            if app_id == "miniapp":
                if not valid_miniapp_data(data):
                    self.fail(category + ":invalid-miniapp-duel")
                try:
                    if len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 12000:
                        self.fail(category + ":miniapp-data-too-large")
                except (UnicodeError, ValueError, RecursionError):
                    self.fail(category + ":invalid-data-encoding")
        if record.get("updatedAt") is not None and not isinstance(record["updatedAt"], str):
            self.fail(category + ":invalid-updatedAt")

    def run(self):
        if not self.root.is_dir():
            self.fail("repository:directory-missing")
            return self.result()
        protocol = self.read("protocol.json", "protocol")
        if protocol is None or type(protocol.get("version")) is not int or protocol["version"] != 1:
            self.fail("protocol:unsupported-or-missing-version")
            return self.result()
        registered = protocol.get("applications")
        if not isinstance(registered, dict):
            self.fail("protocol:invalid-application-registry")
            registered = {}
        for app_id, manifest_path in registered.items():
            if not APP_ID.fullmatch(app_id) or app_id in RESERVED or manifest_path != f"apps/{app_id}.json":
                self.fail("application-manifest:invalid-registration")
                continue
            manifest = self.read(manifest_path, "application-manifest")
            if manifest is not None and (type(manifest.get("version")) is not int or manifest["version"] != 1 or manifest.get("appId") != app_id):
                self.fail("application-manifest:identity-or-version-mismatch")
        index = self.read("users/_index.json", "user-index")
        if index is None:
            return self.result()
        maps = ("usernames", "emails", "google", "verifications", "devices")
        if type(index.get("version")) is not int or index["version"] != 1 or any(not isinstance(index.get(key), dict) for key in maps):
            self.fail("user-index:unsupported-version-or-invalid-maps")
            return self.result()
        user_ids = set()
        for identity_map in maps[:3]:
            for value in index[identity_map].values():
                if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
                    self.fail("user-index:invalid-user-reference")
                else:
                    user_ids.add(value)
        for device in index["devices"].values():
            if not isinstance(device, dict):
                self.fail("user-index:invalid-device-record")
            elif "userId" in device:
                value = device["userId"]
                if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
                    self.fail("user-index:invalid-device-user-reference")
                else:
                    user_ids.add(value)
        for verification in index["verifications"].values():
            if not isinstance(verification, dict):
                self.fail("user-index:invalid-verification-record")
        users_path = self.root / "users"
        if users_path.is_symlink():
            self.fail("users:symlink-refused")
            return self.result()
        try:
            for folder in users_path.iterdir():
                if folder.is_symlink():
                    self.fail("user-directory:symlink-refused")
                    continue
                if folder.is_dir() and (uuid_id(folder.name) or (folder / "profile.json").exists() or (folder / "credentials.json").exists()):
                    if SAFE_ID.fullmatch(folder.name):
                        user_ids.add(folder.name)
                    else:
                        self.fail("user-directory:invalid-id")
        except OSError:
            self.fail("users:unreadable-directory")
        profiles, credentials_by_id = {}, {}
        for user_id in sorted(user_ids):
            self.counts["users"] += 1
            if not uuid_id(user_id):
                self.counts["legacy_user_ids"] += 1
                if not self.allow_legacy_ids:
                    self.fail("user-directory:non-uuid-id-requires-audit")
            profile = self.read(f"users/{user_id}/profile.json", "profile")
            credentials = self.read(f"users/{user_id}/credentials.json", "credentials")
            if profile is not None:
                profiles[user_id] = profile
                if type(profile.get("version")) is not int or profile["version"] != 1 or profile.get("id") != user_id:
                    self.fail("profile:version-or-id-mismatch")
                for field in ("username", "email"):
                    value = profile.get(field)
                    map_name = "usernames" if field == "username" else "emails"
                    if not isinstance(value, str) or not value or index[map_name].get(value.lower()) != user_id:
                        self.fail("profile:missing-or-mismatched-reverse-index")
            if credentials is not None:
                credentials_by_id[user_id] = credentials
                if type(credentials.get("version")) is not int or credentials["version"] != 1 or not isinstance(credentials.get("sessions"), dict):
                    self.fail("credentials:invalid-version-or-sessions")
                if "passwordPlaintext" in credentials and not isinstance(credentials["passwordPlaintext"], str):
                    self.fail("credentials:invalid-plaintext-password-type")
                password = credentials.get("password")
                if password is not None and (not isinstance(password, dict) or password.get("algorithm") != "PBKDF2-SHA256" or password.get("iterations") != 100000 or not encoded_bytes(password.get("salt"), 24) or not encoded_bytes(password.get("hash"), 32)):
                    self.fail("credentials:invalid-password-record")
                if isinstance(credentials.get("sessions"), dict):
                    for grant in credentials["sessions"].values():
                        if not isinstance(grant, dict) or not integer(grant.get("exp"), 1) or grant.get("mode") not in ("web", "native"):
                            self.fail("credentials:invalid-session-record")
                sub = credentials.get("googleSub")
                if sub is not None and (not isinstance(sub, str) or index["google"].get(sub) != user_id):
                    self.fail("credentials:google-reverse-index-mismatch")
            app_folder = users_path / user_id / "apps"
            if (users_path / user_id).is_symlink() or app_folder.is_symlink():
                self.fail("application-directory:symlink-refused")
            elif app_folder.exists():
                try:
                    for app in app_folder.iterdir():
                        if app.is_symlink():
                            self.fail("application-directory:symlink-refused")
                        elif app.is_dir() and app.name in registered:
                            self.app_record(app / "data.json", app.name)
                except OSError:
                    self.fail("application-directory:unreadable")
            legacy = users_path / user_id / "data.json"
            if legacy.exists() or legacy.is_symlink():
                self.app_record(legacy, "brclio")
        for map_name, field, records in (("usernames", "username", profiles), ("emails", "email", profiles), ("google", "googleSub", credentials_by_id)):
            for key, user_id in index[map_name].items():
                record = records.get(user_id) if isinstance(user_id, str) else None
                value = record.get(field) if record else None
                expected = value if field == "googleSub" else value.lower() if isinstance(value, str) else None
                if key != expected:
                    self.fail("user-index:dangling-or-mismatched-identity-reference")
        return self.result()

    def result(self):
        print(json.dumps({"ok": not self.errors, "counts": dict(sorted(self.counts.items())), "errors": dict(sorted(self.errors.items())), "readOnly": True}, ensure_ascii=False))
        return 1 if self.errors else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path, help="Local private clone or backup directory")
    parser.add_argument("--allow-legacy-ids", action="store_true", help="Preserve audited preexisting non-UUID IDs; never use for new accounts")
    options = parser.parse_args()
    return Validator(options.repository, options.allow_legacy_ids).run()


if __name__ == "__main__":
    sys.exit(main())
