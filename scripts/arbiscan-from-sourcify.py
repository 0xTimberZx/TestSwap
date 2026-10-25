#!/usr/bin/env python3
"""Submit Sourcify-verified contracts to Arbiscan.

For each "name address" line on stdin: skip it if Arbiscan already has the
source; otherwise take the standard-JSON input, compiler version, contract
name and constructor arguments Sourcify recorded for it and submit them to
the Etherscan v2 API (verifysourcecode), then poll the result.

Sourcify keeps the exact build that matched the chain, so no deploy commit or
compiler settings have to be reconstructed. Arbiscan does its own comparison
and may still reject a Sourcify partial match (metadata hash differs).

Env: ARBISCAN_API_KEY, CHAIN_ID (default 421614).
Exits 1 if any submission was rejected.

  python3 scripts/arbiscan-from-sourcify.py < addresses.txt
  python3 scripts/arbiscan-from-sourcify.py --self-test
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SOURCIFY = "https://sourcify.dev/server"
ETHERSCAN = "https://api.etherscan.io/v2/api"


def http_get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


def http_post(url, form):
    data = urllib.parse.urlencode(form).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=60) as r:
        return json.loads(r.read().decode())


def arbiscan_verified(get, chain, key, addr):
    q = urllib.parse.urlencode({"chainid": chain, "module": "contract", "action": "getsourcecode",
                                "address": addr, "apikey": key})
    j = get(f"{ETHERSCAN}?{q}")
    if j.get("status") != "1":
        raise RuntimeError(f"getsourcecode: {j.get('result') or j.get('message')}")
    return bool((j["result"][0] or {}).get("SourceCode"))


def sourcify_build(get, chain, addr):
    """Return the submission fields, or None if Sourcify has no match."""
    try:
        j = get(f"{SOURCIFY}/v2/contract/{chain}/{addr}?fields=all")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    if not j.get("match"):
        return None
    comp = j["compilation"]
    args = ((j.get("creationBytecode") or {}).get("transformationValues") or {}).get("constructorArguments") or ""
    return {
        "match": j["match"],
        "sourceCode": json.dumps(j["stdJsonInput"]),
        "contractname": comp["fullyQualifiedName"],
        "compilerversion": "v" + comp["compilerVersion"].lstrip("v"),
        "constructorArguements": args[2:] if args.startswith("0x") else args,  # (sic) Etherscan's spelling
    }


def submit(get, post, chain, key, addr, build, sleep=time.sleep, polls=8):
    form = {"apikey": key, "module": "contract", "action": "verifysourcecode",
            "codeformat": "solidity-standard-json-input", "contractaddress": addr,
            "sourceCode": build["sourceCode"], "contractname": build["contractname"],
            "compilerversion": build["compilerversion"],
            "constructorArguements": build["constructorArguements"]}
    j = post(f"{ETHERSCAN}?chainid={chain}", form)
    if j.get("status") != "1":
        msg = str(j.get("result") or j.get("message"))
        return ("verified", msg) if "already verified" in msg.lower() else ("rejected", msg)
    guid = j["result"]
    q = urllib.parse.urlencode({"chainid": chain, "module": "contract", "action": "checkverifystatus",
                                "guid": guid, "apikey": key})
    for _ in range(polls):
        sleep(5)
        r = get(f"{ETHERSCAN}?{q}")
        msg = str(r.get("result"))
        if "pending" in msg.lower():
            continue
        if r.get("status") == "1" or "already verified" in msg.lower():
            return ("verified", msg)
        return ("rejected", msg)
    return ("pending", f"still pending after {polls} polls (guid {guid})")


def run(lines, get, post, chain, key, sleep=time.sleep, out=print):
    rows, failed = [], 0
    for line in lines:
        parts = line.split()
        if len(parts) != 2:
            continue
        name, addr = parts
        try:
            if arbiscan_verified(get, chain, key, addr):
                continue  # already on Arbiscan: nothing to do
            sleep(0.5)
            build = sourcify_build(get, chain, addr)
            if build is None:
                rows.append((name, addr, "not on Sourcify", "skipped"))
                continue
            state, msg = submit(get, post, chain, key, addr, build, sleep)
        except Exception as e:  # report and carry on with the rest
            state, msg, build = "error", str(e)[:120], None
        if state != "verified":
            failed += 1
        rows.append((name, addr, (build or {}).get("match", "-"), f"{state}: {msg[:100]}"))
        sleep(0.5)
    for r in rows:
        out(f"{r[0]:<24} {r[1]} sourcify={r[2]:<12} {r[3]}")
    return rows, failed


def self_test():
    """Offline checks of the decision logic with a fake API."""
    ok = 0
    sv = {"0xA": {"match": "match", "compilation": {"fullyQualifiedName": "contracts/A.sol:A",
                                                    "compilerVersion": "0.8.24+commit.e11b9ed9"},
                  "stdJsonInput": {"language": "Solidity", "sources": {}, "settings": {}},
                  "creationBytecode": {"transformationValues": {"constructorArguments": "0x00ff"}}}}
    arb = {"0xA": False, "0xB": True, "0xC": False}
    posted = []

    def get(url):
        if "getsourcecode" in url:
            a = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["address"][0]
            return {"status": "1", "result": [{"SourceCode": "x" if arb[a] else ""}]}
        if "checkverifystatus" in url:
            return {"status": "1", "result": "Pass - Verified"}
        a = url.split("/")[-1].split("?")[0]
        if a not in sv:
            raise urllib.error.HTTPError(url, 404, "nf", None, None)
        return sv[a]

    def post(url, form):
        posted.append(form)
        return {"status": "1", "result": "guid123"}

    rows, failed = run(["A 0xA", "B 0xB", "C 0xC"], get, post, "421614", "k", sleep=lambda s: None, out=lambda s: None)
    checks = [
        (len(posted) == 1, "only the Sourcify-verified, Arbiscan-missing address is submitted"),
        (posted and posted[0]["constructorArguements"] == "00ff", "constructor args without 0x"),
        (posted and posted[0]["compilerversion"] == "v0.8.24+commit.e11b9ed9", "compiler version gets a v"),
        (posted and posted[0]["contractname"] == "contracts/A.sol:A", "fully qualified name"),
        (posted and json.loads(posted[0]["sourceCode"])["language"] == "Solidity", "standard JSON passed through"),
        (any(r[0] == "C" and r[3] == "skipped" for r in rows), "not on Sourcify is reported, not submitted"),
        (not any(r[0] == "B" for r in rows), "already on Arbiscan is skipped silently"),
        (failed == 0, "a pass is not a failure"),
    ]
    for cond, label in checks:
        print(("ok   " if cond else "FAIL ") + label)
        ok += cond
    print(f"{ok}/{len(checks)} passed")
    return ok == len(checks)


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(0 if self_test() else 1)
    key = os.environ.get("ARBISCAN_API_KEY")
    if not key:
        sys.exit("ARBISCAN_API_KEY is not set")
    chain = os.environ.get("CHAIN_ID", "421614")
    _, failed = run(sys.stdin.read().splitlines(), http_get, http_post, chain, key)
    sys.exit(1 if failed else 0)
