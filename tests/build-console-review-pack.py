"""Strict WebMaker-style review pack for an independent, new-context visual judge.

This pack deliberately excludes source code, diffs, builder notes and pass/fail
claims. It is not itself an independent visual review.
"""
from pathlib import Path
import json
import struct
import sys
import zipfile

root=Path(__file__).resolve().parent.parent
runtime=root/"tests"/".review-runtime"
cycle=int(sys.argv[1]) if len(sys.argv)>1 else 1
if cycle<1:
    raise SystemExit("Review cycle must be positive")
output=runtime/f"review-cycle-{cycle}.zip"
if output.exists():
    raise SystemExit("Refusing to overwrite an existing review cycle: "+str(output))

report=json.loads((runtime/"browser-acceptance.json").read_text(encoding="utf-8"))
if report.get("browserExceptions"):
    raise SystemExit("Browser exceptions exist; review pack cannot be generated")

metrics=[]
for item in report["observations"]:
    if item.get("name","").startswith("full-navigation-"):
        metrics.append({k:item[k] for k in
            ("name","width","documentWidth","view","panels","overlap",
             "ownerCopies","serviceControls","rollbackControls") if k in item})
    elif item.get("name") in (
        "desktop-zh-dark","desktop-1024-en-dark","tablet-768-zh-light",
        "mobile-zh-dark"):
        metrics.append({k:item[k] for k in
            ("name","width","documentWidth","textContrast","mutedContrast",
             "accentContrast","navCount","focusable") if k in item})

def png_width(path):
    header=path.read_bytes()[:24]
    if len(header)<24 or header[:8]!=b"\x89PNG\r\n\x1a\n" or header[12:16]!=b"IHDR":
        raise SystemExit("Not a valid PNG: "+str(path))
    return struct.unpack(">I",header[16:20])[0]

items={
    "DESIGN.md":root/"docs"/"CONSOLE_DESIGN_CONTRACT.md",
    "BRIEF.md":root/"docs"/"CONSOLE_BRIEF.md",
}
for width in (1440,1024,768,390):
    source=runtime/f"clean-{width}.png"
    if not source.is_file() or png_width(source)!=width:
        raise SystemExit(f"Missing or mislabelled {width}px clean screenshot")
    items[f"screenshots/{width}.png"]=source
for name in ("dialog-focus.png","error-state.png"):
    source=runtime/name
    if source.is_file() and png_width(source)>0:
        items["screenshots/"+("modal-" if name.startswith("dialog") else "error-")+name]=source

with zipfile.ZipFile(output,"x",compression=zipfile.ZIP_DEFLATED) as archive:
    for name,source in items.items():
        archive.write(source,name)
    archive.writestr("deterministic-metrics.json",
        json.dumps({"measurements":metrics},ensure_ascii=False,indent=2))
with zipfile.ZipFile(output) as archive:
    expected=set(items)|{"deterministic-metrics.json"}
    if set(archive.namelist())!=expected:
        raise SystemExit("Review pack whitelist violation")
print("review_pack="+str(output))
print("files="+str(len(expected))+" measurements="+str(len(metrics)))
