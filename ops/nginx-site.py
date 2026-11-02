#!/usr/bin/env python3
"""Generate the arena nginx site so that it mirrors the portfolio's real setup.

Reads `nginx -T` on stdin, finds the portfolio's server block (server_name contains
svanda.tech, listens on 443) and writes a site for arena.svanda.tech that uses the
SAME listen addresses (nginx picks blocks by ip:port before server_name, so a plain
`listen 443` would never be considered if the portfolio listens on a specific IP),
the same certificate and the same config directory (so it is actually included).

argv: <template> <output-file> <fallback-cert> <fallback-key>
stdout (tab-separated): target_path  link_path  check_ip  cert
"""
import os, re, sys

template, out_file, fb_cert, fb_key = sys.argv[1:5]
dump = sys.stdin.read()
parts = re.split(r"^# configuration file (.+?):\s*$", dump, flags=re.M)

def blocks():
    for i in range(1, len(parts), 2):
        path, text = parts[i], re.sub(r"#[^\n]*", "", parts[i + 1])
        for m in re.finditer(r"\bserver\s*\{", text):
            j, depth = m.end(), 1
            while j < len(text) and depth:
                depth += {"{": 1, "}": -1}.get(text[j], 0)
                j += 1
            top = text[m.end():j - 1]
            for _ in range(4):
                top = re.sub(r"\{[^{}]*\}", "{}", top)
            yield {
                "path": path,
                "names": " ".join(re.findall(r"\bserver_name\s+([^;]+);", top)).split(),
                "listens": [l.strip() for l in re.findall(r"\blisten\s+([^;]+);", top)],
                "cert": (re.findall(r"\bssl_certificate\s+([^;]+);", top) or [None])[0],
                "key": (re.findall(r"\bssl_certificate_key\s+([^;]+);", top) or [None])[0],
            }

DROP = {"default_server", "default", "reuseport", "deferred", "bind", "ipv6only=on", "ipv6only=off"}
def clean(listen):
    toks = [t for t in listen.split() if t not in DROP and not re.match(r"(backlog|fastopen|rcvbuf|sndbuf|so_keepalive)=", t)]
    return " ".join(toks)

cands = [b for b in blocks()
         if "arena" not in b["path"] and not any("arena." in n for n in b["names"])
         and any(n in ("svanda.tech", "www.svanda.tech") or n.endswith(".svanda.tech") for n in b["names"])
         and any("443" in l for l in b["listens"])]
p = cands[0] if cands else None

l443 = [clean(l) for l in (p["listens"] if p else []) if "443" in l and "quic" not in l] or ["443 ssl", "[::]:443 ssl"]
l80 = []
for b in blocks():
    if p and b["path"] == p["path"]:
        l80 += [clean(l) for l in b["listens"] if re.match(r"^(\S+:)?80(\s|$)", l)]
l80 = sorted(set(l80)) or ["80", "[::]:80"]
cert = (p and p["cert"]) or fb_cert
key = (p and p["key"]) or fb_key

conf = open(template).read()
conf = conf.replace("    listen 80;\n    listen [::]:80;\n", "".join(f"    listen {l};\n" for l in l80))
conf = conf.replace("    listen 443 ssl;\n    listen [::]:443 ssl;\n", "".join(f"    listen {l};\n" for l in l443))
conf = conf.replace("/etc/ssl/cloudflare/svanda.tech.pem", cert).replace("/etc/ssl/cloudflare/svanda.tech.key", key)
open(out_file, "w").write(conf)

d = os.path.dirname(p["path"]) if p else "/etc/nginx/conf.d"
if d.endswith("sites-enabled"):
    target = os.path.join(os.path.dirname(d), "sites-available", "arena.svanda.tech")
    link = os.path.join(d, "arena.svanda.tech")
else:
    target, link = os.path.join(d, "arena.svanda.tech.conf"), ""
m = re.match(r"^([\d.]+):443", l443[0])
check_ip = m.group(1) if m else "127.0.0.1"
print(f"{target}\t{link}\t{check_ip}\t{cert}")
