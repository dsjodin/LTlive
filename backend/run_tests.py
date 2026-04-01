#!/usr/bin/env python3
"""CLI test runner for LTlive.

Calls /api/test/run on a running backend and prints results with ANSI colors.
Exit code: 0 if no failures, 1 if any check failed.

Usage:
    python run_tests.py                         # default: http://localhost:5000
    python run_tests.py --url http://host:port
"""

import argparse
import json
import sys
import urllib.request
import urllib.error

# ANSI colors
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"

STATUS_ICON = {
    "ok": f"{GREEN}[OK]{RESET}",
    "warn": f"{YELLOW}[WARN]{RESET}",
    "fail": f"{RED}[FAIL]{RESET}",
}


def fetch_results(base_url):
    url = base_url.rstrip("/") + "/api/test/run"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        print(f"{RED}Kunde inte na {url}: {e}{RESET}", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"{RED}Fel: {e}{RESET}", file=sys.stderr)
        sys.exit(2)


def print_results(data):
    s = data["sammanfattning"]

    print()
    print(f"{BOLD}LTlive Systemtest{RESET}")
    print("=" * 50)
    print()

    for kat in data["kategorier"]:
        checks = kat["kontroller"]
        ok = sum(1 for c in checks if c["status"] == "ok")
        warn = sum(1 for c in checks if c["status"] == "warn")
        fail = sum(1 for c in checks if c["status"] == "fail")

        parts = []
        if ok: parts.append(f"{GREEN}{ok} ok{RESET}")
        if warn: parts.append(f"{YELLOW}{warn} varningar{RESET}")
        if fail: parts.append(f"{RED}{fail} fel{RESET}")

        print(f"{BOLD}{kat['namn']}{RESET}  [{', '.join(parts)}]")

        for check in checks:
            icon = STATUS_ICON.get(check["status"], "[ ? ]")
            msg = f"{DIM}{check['meddelande']}{RESET}" if check["status"] == "ok" else check["meddelande"]
            print(f"  {icon}  {check['namn']} -- {msg}")

        print()

    # Summary line
    print("=" * 50)
    summary_parts = []
    if s["ok"]: summary_parts.append(f"{GREEN}{s['ok']} ok{RESET}")
    if s["warn"]: summary_parts.append(f"{YELLOW}{s['warn']} varningar{RESET}")
    if s["fail"]: summary_parts.append(f"{RED}{s['fail']} fel{RESET}")
    print(f"{BOLD}Sammanfattning:{RESET} {', '.join(summary_parts)} ({s['totalt']} totalt)")
    print()

    return s["fail"]


def main():
    parser = argparse.ArgumentParser(description="LTlive systemtest (CLI)")
    parser.add_argument("--url", default="http://localhost:5000", help="Backend-URL (default: http://localhost:5000)")
    args = parser.parse_args()

    data = fetch_results(args.url)
    fail_count = print_results(data)
    sys.exit(1 if fail_count > 0 else 0)


if __name__ == "__main__":
    main()
