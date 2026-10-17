#!/bin/sh
# usage: sh agents/check-fixtures.sh good|bad  -> runs that fixture on :18999 and attacks it
set -e
d=$(mktemp -d); cp -r service/. "$d"; node -e 'const p=require("./agents/fixtures/'$1'-patch.json");for(const[k,v]of Object.entries(p.files))require("fs").writeFileSync(process.argv[1]+"/"+k,v)' "$d"
PORT=18999 node "$d/server.js" & pid=$!; sleep 0.7
node agents/attacks/attack.js http://127.0.0.1:18999 $1 | tail -1 | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{for(const r of JSON.parse(s).results)console.log(r.passed?"PASS":"FAIL",r.name,"-",r.detail)})'
kill $pid 2>/dev/null || true
