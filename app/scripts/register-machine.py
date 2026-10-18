#!/usr/bin/env python3
"""Register a machine in data/catalog.json — the step that is easy to forget.

A machine file dropped into data/ without a catalog entry is INVISIBLE in the
app (models.ts only ever fetches resources named by catalog.json), and a
machine without a data/guides.json entry hard-FAILS deploy-prod.sh, because
that script requires app/dist/machines/ to hold exactly one directory per
catalog entry. Both failure modes are silent until late, so this does the
catalog half mechanically and reports on the guide half.

Usage:
    python3 app/scripts/register-machine.py <id> <resource> "<full name>" "<SHORT>"

e.g. register-machine.py demolition-man demolition_man_goals \
        "Demolition Man (Williams, 1994)" "DEMOLITION MAN"

Idempotent — re-registering an existing id updates it in place.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"


def main(argv: list[str]) -> int:
    if len(argv) != 5:
        print(__doc__)
        return 2
    _, machine_id, resource, name, short = argv

    if not (DATA / f"{resource}.json").exists():
        print(f"ERROR: data/{resource}.json does not exist — write the machine data first")
        return 1

    catalog_path = DATA / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    entry = {"id": machine_id, "name": name, "shortTitle": short, "resource": resource}

    for i, existing in enumerate(catalog):
        if existing["id"] == machine_id:
            catalog[i] = entry
            action = "updated"
            break
    else:
        catalog.append(entry)
        action = "added"

    catalog_path.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"catalog.json: {action} {machine_id} ({len(catalog)} machines)")

    guides = json.loads((DATA / "guides.json").read_text(encoding="utf-8"))
    if not any(g["slug"] == machine_id for g in guides):
        print(
            f"WARNING: data/guides.json has no entry for {machine_id!r}.\n"
            "         deploy-prod.sh WILL FAIL: it requires one dist/machines/ directory\n"
            "         per catalog entry. Write the guide prose before deploying."
        )
        return 1
    print(f"guides.json: {machine_id} present — deploy gate satisfied")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
