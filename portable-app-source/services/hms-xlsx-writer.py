"""Small dependency-free XLSX backend for Hermes leaf workers."""

import argparse
import json
import os
import re
import zipfile
from datetime import datetime, timezone
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def column_name(index):
    value = index + 1
    result = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def sheet_name(value, index):
    cleaned = re.sub(r"[\\/*?:\[\]]", "_", str(value or "").strip())[:31]
    return cleaned or f"Sheet{index + 1}"


def cell_xml(value, row_index, column_index):
    reference = f"{column_name(column_index)}{row_index + 1}"
    if value is None:
        return f'<c r="{reference}" t="inlineStr"><is><t></t></is></c>'
    if isinstance(value, bool):
        return f'<c r="{reference}" t="b"><v>{1 if value else 0}</v></c>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{reference}" t="n"><v>{value}</v></c>'
    text = escape(str(value))
    preserve = ' xml:space="preserve"' if text[:1].isspace() or text[-1:].isspace() else ""
    return f'<c r="{reference}" t="inlineStr"><is><t{preserve}>{text}</t></is></c>'


def worksheet_xml(rows):
    body = []
    for row_index, row in enumerate(rows):
        values = row if isinstance(row, list) else [row]
        cells = "".join(cell_xml(value, row_index, column_index) for column_index, value in enumerate(values))
        body.append(f'<row r="{row_index + 1}">{cells}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{MAIN_NS}"><sheetData>{"".join(body)}</sheetData></worksheet>'
    )


def normalized_sheets(spec):
    raw_sheets = spec.get("sheets") if isinstance(spec, dict) else None
    if not isinstance(raw_sheets, list) or not raw_sheets:
        raw_sheets = [{"name": spec.get("sheet", "Sheet1"), "rows": spec.get("rows", [])}]
    result = []
    used = set()
    for index, item in enumerate(raw_sheets):
        item = item if isinstance(item, dict) else {"rows": item}
        name = sheet_name(item.get("name"), index)
        base = name
        suffix = 2
        while name.lower() in used:
            tail = f"-{suffix}"
            name = f"{base[:31 - len(tail)]}{tail}"
            suffix += 1
        used.add(name.lower())
        rows = item.get("rows", [])
        if not isinstance(rows, list):
            raise ValueError(f"Sheet {name} rows must be a list")
        result.append({"name": name, "rows": rows})
    return result


def write_xlsx(output, spec):
    sheets = normalized_sheets(spec)
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    content_types = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ]
    for index in range(len(sheets)):
        content_types.append(f'<Override PartName="/xl/worksheets/sheet{index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    content_types.append("</Types>")
    workbook_sheets = "".join(
        f'<sheet name="{escape(item["name"])}" sheetId="{index + 1}" r:id="rId{index + 1}"/>'
        for index, item in enumerate(sheets)
    )
    workbook_rels = "".join(
        f'<Relationship Id="rId{index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index + 1}.xml"/>'
        for index in range(len(sheets))
    )
    workbook_rels += f'<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    files = {
        "[Content_Types].xml": "".join(content_types),
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
        "xl/workbook.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="{MAIN_NS}" xmlns:r="{REL_NS}"><sheets>{workbook_sheets}</sheets></workbook>',
        "xl/_rels/workbook.xml.rels": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{workbook_rels}</Relationships>',
        "xl/styles.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="{MAIN_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>',
        "docProps/core.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>白球AI 黑球</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created></cp:coreProperties>',
        "docProps/app.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Baiqiu AI</Application></Properties>',
    }
    for index, item in enumerate(sheets):
        files[f"xl/worksheets/sheet{index + 1}.xml"] = worksheet_xml(item["rows"])
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content.encode("utf-8"))
    with zipfile.ZipFile(output, "r") as archive:
        if archive.testzip() is not None:
            raise ValueError("XLSX ZIP verification failed")
    return {"ok": True, "path": os.path.abspath(output), "sheets": [{"name": item["name"], "rows": len(item["rows"])} for item in sheets]}


def inspect_xlsx(source):
    with zipfile.ZipFile(source, "r") as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships}
        result = []
        for sheet in workbook.findall(f"{{{MAIN_NS}}}sheets/{{{MAIN_NS}}}sheet"):
            relationship_id = sheet.attrib[f"{{{REL_NS}}}id"]
            target = targets[relationship_id].lstrip("/")
            target = target if target.startswith("xl/") else f"xl/{target}"
            worksheet = ET.fromstring(archive.read(target))
            rows = []
            for row in worksheet.findall(f".//{{{MAIN_NS}}}row"):
                values = []
                for cell in row.findall(f"{{{MAIN_NS}}}c"):
                    inline = cell.find(f"{{{MAIN_NS}}}is/{{{MAIN_NS}}}t")
                    numeric = cell.find(f"{{{MAIN_NS}}}v")
                    values.append(inline.text if inline is not None else numeric.text if numeric is not None else "")
                rows.append(values)
            result.append({"name": sheet.attrib.get("name", ""), "rows": rows})
    return {"ok": True, "path": os.path.abspath(source), "sheets": result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    parser.add_argument("--spec")
    parser.add_argument("--inspect")
    args = parser.parse_args()
    if args.inspect:
        result = inspect_xlsx(args.inspect)
    else:
        if not args.output or not args.spec:
            parser.error("--output and --spec are required")
        with open(args.spec, "r", encoding="utf-8-sig") as handle:
            result = write_xlsx(args.output, json.load(handle))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
