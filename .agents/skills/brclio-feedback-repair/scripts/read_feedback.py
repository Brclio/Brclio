#!/usr/bin/env python3
"""Read one private report at a consistent commit through an authenticated gh CLI."""
import json
import re
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

REPO = "repos/BrclioData/BrclioLogData"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def main(value):
    if value.startswith("https://"):
        url = urlsplit(value)
        if (url.netloc, url.path) != ("tools.brclio.com", "/admin"):
            raise ValueError("请使用 Brclio 后台的问题链接")
        value = parse_qs(url.query).get("feedback", [""])[0]
    if not UUID.fullmatch(value):
        raise ValueError("请提供有效的反馈编号")
    revision = subprocess.check_output(["gh", "api", REPO + "/commits/HEAD", "--jq", ".sha"], text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("无法确认私库版本")
    directory = f"{REPO}/contents/feedback/v1/reports/{value[:2]}/{value}"

    def read(filename):
        response = subprocess.check_output(["gh", "api", directory + "/" + filename, "-X", "GET",
                                            "-f", "ref=" + revision, "-H", "Accept: application/vnd.github.raw+json"])
        return json.loads(response)

    report = read("report.json")
    if report.get("id") != value:
        raise ValueError("反馈记录编号与请求不一致")
    logs = []
    for day in report["logDays"]:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise ValueError("无效日志日期")
        logs.extend(read(f"logs/{day}.json")["entries"])
    if len(logs) != report["logCount"]:
        raise ValueError("日志数量与反馈记录不一致")
    last_history = report["revision"] // 50 + 1
    result = {key: report[key] for key in ("id", "title", "description", "category", "createdAt", "updatedAt",
                                            "status", "platform", "appVersion", "revision")}
    result.update({"logs": logs, "recentHistory": read(f"history/{last_history:06d}.json")["entries"]})
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("用法: read_feedback.py <反馈编号或问题链接>")
    try:
        main(sys.argv[1])
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"读取反馈失败：{error}")
