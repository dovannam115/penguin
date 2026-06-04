#!/usr/bin/env python
"""
pptx_gen.py — Engine tạo slide PowerPoint bám theo template bất kỳ.

Dùng bởi Agent P (lib/office-tools/pptx-export.ts). Hai lệnh:

  inspect <template.pptx>
      In ra JSON: kích thước slide, danh sách layout (kèm placeholder),
      và các slide mẫu có sẵn trong file (để clone-and-fill).

  generate <spec.json>
      Đọc spec JSON, tạo file .pptx mới bám theo template.
      Spec: { template, output, slides: [ ... ] }
        slide kiểu layout: {"from_layout":"TITLE_AND_BODY","title":..,
                            "subtitle":..,"body":[..],"body_right":[..]}
        slide kiểu clone : {"clone_slide": <index>,
                            "replace":[{"find":"x","with":"y"}, ...]}
      In ra JSON kết quả: { path, size, n_slides }.

KHÔNG phụ thuộc gì ngoài python-pptx.
"""
import sys
import io
import json
import copy

# Console Windows hay là cp1252 -> ép UTF-8 để in tiếng Việt không vỡ.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from pptx import Presentation
from pptx.util import Emu, Inches
from pptx.enum.shapes import PP_PLACEHOLDER, MSO_SHAPE_TYPE
from pptx.oxml.ns import qn


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def layout_map(prs):
    """name (upper) -> layout, gộp tất cả master, first-match-wins."""
    m = {}
    for master in prs.slide_masters:
        for layout in master.slide_layouts:
            key = (layout.name or "").strip().upper()
            if key and key not in m:
                m[key] = layout
    return m


def shape_text(shape):
    if shape.has_text_frame:
        return shape.text_frame.text
    return ""


def set_placeholder_text(ph, text):
    tf = ph.text_frame
    tf.clear()
    tf.paragraphs[0].text = text if text is not None else ""


def set_placeholder_bullets(ph, bullets):
    tf = ph.text_frame
    tf.clear()
    if not bullets:
        return
    tf.paragraphs[0].text = str(bullets[0])
    for b in bullets[1:]:
        p = tf.add_paragraph()
        p.text = str(b)


def duplicate_slide(prs, index):
    """Nhân bản slide thứ <index> (giữ nguyên shape/vector/ảnh) và thêm vào cuối.
    Đủ tốt cho deck Slidesgo (text + vector, không chart phức tạp)."""
    source = prs.slides[index]
    new_slide = prs.slides.add_slide(source.slide_layout)
    # Xoá các placeholder mà layout vừa thêm vào -> dùng nguyên shape của source.
    for shp in list(new_slide.shapes):
        shp._element.getparent().remove(shp._element)
    # Copy toàn bộ shape XML từ source.
    for shp in source.shapes:
        new_slide.shapes._spTree.append(copy.deepcopy(shp._element))
    # Copy quan hệ ảnh (nếu có) để hình không mất.
    for rel in source.part.rels.values():
        if "image" in rel.reltype:
            new_slide.part.rels.get_or_add(rel.reltype, rel._target)
    return new_slide


def replace_text_in_slide(slide, pairs):
    """pairs: list[(find, replace)]. Thay ở mức paragraph để không vỡ khi
    PowerPoint cắt chữ thành nhiều run. Giữ format của run đầu."""
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for para in shape.text_frame.paragraphs:
            full = "".join(r.text for r in para.runs)
            if not full:
                continue
            new = full
            for find, repl in pairs:
                if find and find in new:
                    new = new.replace(find, repl)
            if new != full and para.runs:
                para.runs[0].text = new
                for r in para.runs[1:]:
                    r.text = ""


def delete_slides(prs, indices):
    """Xoá các slide theo index (set). Gỡ khỏi sldIdLst + drop relationship."""
    sld_id_lst = prs.slides._sldIdLst
    sld_ids = list(sld_id_lst)
    drop = sorted(indices, reverse=True)
    for i in drop:
        if i < 0 or i >= len(sld_ids):
            continue
        sld_id = sld_ids[i]
        rId = sld_id.get(qn("r:id"))
        try:
            prs.part.drop_rel(rId)
        except Exception:
            pass
        sld_id_lst.remove(sld_id)


# ----------------------------------------------------------------------------
# theme extraction (palette + fonts) — để Aria THAM KHẢO khi dựng deck HTML
# ----------------------------------------------------------------------------
_RT_THEME = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"


def _local(tag):
    return tag.split("}")[-1]


def extract_theme(prs):
    # python-pptx keeps the theme as an opaque Part (blob, no parsed element),
    # so locate it via the master's relationships and parse the XML ourselves.
    part = None
    for master in prs.slide_masters:
        for rel in master.part.rels.values():
            if not rel.is_external and "theme" in rel.reltype:
                part = rel._target
                break
        if part is not None:
            break
    if part is None:
        return {}
    from lxml import etree
    try:
        el = etree.fromstring(part.blob)
    except Exception:
        return {}
    colors = {}
    clr = el.find(".//" + qn("a:clrScheme"))
    if clr is not None:
        for child in clr:
            srgb = child.find(qn("a:srgbClr"))
            sysc = child.find(qn("a:sysClr"))
            val = None
            if srgb is not None and srgb.get("val"):
                val = srgb.get("val")
            elif sysc is not None and sysc.get("lastClr"):
                val = sysc.get("lastClr")
            if val:
                colors[_local(child.tag)] = "#" + val.upper()
    fonts = {}
    fs = el.find(".//" + qn("a:fontScheme"))
    if fs is not None:
        major = fs.find(qn("a:majorFont") + "/" + qn("a:latin"))
        minor = fs.find(qn("a:minorFont") + "/" + qn("a:latin"))
        if major is not None and major.get("typeface"):
            fonts["major"] = major.get("typeface")
        if minor is not None and minor.get("typeface"):
            fonts["minor"] = minor.get("typeface")
    return {"colors": colors, "fonts": fonts}


# ----------------------------------------------------------------------------
# inspect
# ----------------------------------------------------------------------------
def cmd_inspect(template_path):
    prs = Presentation(template_path)
    layouts = []
    for master in prs.slide_masters:
        for li, layout in enumerate(master.slide_layouts):
            phs = []
            for p in layout.placeholders:
                phs.append({
                    "idx": p.placeholder_format.idx,
                    "type": str(p.placeholder_format.type),
                })
            layouts.append({"name": layout.name, "placeholders": phs})

    demo = []
    for si, slide in enumerate(prs.slides):
        texts = []
        for shp in slide.shapes:
            t = shape_text(shp).strip()
            if t:
                texts.append(t.replace("\n", " / ")[:60])
        demo.append({
            "index": si,
            "layout": slide.slide_layout.name,
            "n_shapes": len(slide.shapes),
            "texts": texts[:12],
        })

    out = {
        "slide_size_in": [round(Emu(prs.slide_width).inches, 2),
                          round(Emu(prs.slide_height).inches, 2)],
        "theme": extract_theme(prs),
        "n_layouts": len(layouts),
        "layouts": layouts,
        "n_demo_slides": len(demo),
        "demo_slides": demo,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


# ----------------------------------------------------------------------------
# outline — dùng cho PREVIEW: text đầy đủ từng slide (không cắt)
# ----------------------------------------------------------------------------
def cmd_outline(template_path):
    prs = Presentation(template_path)
    slides = []
    for si, slide in enumerate(prs.slides):
        blocks = []
        for shp in slide.shapes:
            if shp.has_text_frame:
                t = shp.text_frame.text.strip()
                if t:
                    blocks.append(t)
        slides.append({"index": si, "blocks": blocks})
    print(json.dumps({"n_slides": len(slides), "slides": slides},
                     ensure_ascii=False))


# ----------------------------------------------------------------------------
# preview — trích shape (vị trí/màu/viền/text/ảnh) từng slide cho PREVIEW TRỰC
# QUAN trong app, KHÔNG cần PowerPoint. Toạ độ trả về dạng phân số 0..1 của slide.
# ----------------------------------------------------------------------------
def _shape_fill_hex(shape):
    try:
        f = shape.fill
        if f.type == 1:  # MSO_FILL.SOLID
            c = f.fore_color
            if c.type == 1:  # RGB
                return "#" + str(c.rgb)
    except Exception:
        pass
    return None


def _shape_line(shape):
    try:
        ln = shape.line
        if ln.fill.type == 1:  # solid
            rgb = ln.color.rgb
            w = ln.width
            return "#" + str(rgb), (w.pt if w is not None else 1.0)
    except Exception:
        pass
    return None, 0


def _para_runs(tf):
    """text_frame -> list runs ([{text,size_pt,color,bold,italic}] + {br:1})."""
    out = []
    first = True
    for para in tf.paragraphs:
        if not first:
            out.append({"br": 1})
        first = False
        for r in para.runs:
            f = r.font
            col = None
            try:
                if f.color and f.color.type == 1:
                    col = "#" + str(f.color.rgb)
            except Exception:
                col = None
            out.append({
                "text": r.text,
                "size_pt": (f.size.pt if f.size is not None else None),
                "color": col,
                "bold": bool(f.bold),
                "italic": bool(f.italic),
            })
        if not para.runs and para.text:
            out.append({"text": para.text, "size_pt": None, "color": None,
                        "bold": False, "italic": False})
    return out


def cmd_preview(pptx_path):
    import base64
    prs = Presentation(pptx_path)
    W = float(prs.slide_width)
    H = float(prs.slide_height)
    _ANCH = {1: "top", 2: "middle", 3: "bottom"}
    _ALN = {1: "left", 2: "center", 3: "right", 4: "justify"}

    slides_out = []
    for slide in prs.slides:
        shapes = []
        for shp in slide.shapes:
            try:
                x, y, w, h = shp.left, shp.top, shp.width, shp.height
                if x is None or y is None or w is None or h is None:
                    continue
                item = {
                    "x": round(x / W, 5), "y": round(y / H, 5),
                    "w": round(w / W, 5), "h": round(h / H, 5),
                }
                # ảnh
                if shp.shape_type == MSO_SHAPE_TYPE.PICTURE:
                    try:
                        img = shp.image
                        b64 = base64.b64encode(img.blob).decode("ascii")
                        item["img"] = "data:%s;base64,%s" % (img.content_type, b64)
                    except Exception:
                        pass
                else:
                    fill = _shape_fill_hex(shp)
                    line, lw = _shape_line(shp)
                    if fill:
                        item["fill"] = fill
                    if line and lw:
                        item["line"] = line
                        item["line_w"] = round(lw, 2)
                    # bo góc autoshape (xấp xỉ)
                    try:
                        if shp.adjustments and len(shp.adjustments):
                            adj = shp.adjustments[0]
                            if 0 < adj <= 0.5:
                                item["radius"] = round(adj, 3)
                    except Exception:
                        pass
                # text
                if shp.has_text_frame and shp.text_frame.text.strip():
                    item["runs"] = _para_runs(shp.text_frame)
                    p0 = shp.text_frame.paragraphs[0]
                    try:
                        item["align"] = _ALN.get(int(p0.alignment), "left") if p0.alignment is not None else "left"
                    except Exception:
                        item["align"] = "left"
                    try:
                        item["valign"] = _ANCH.get(int(shp.text_frame.vertical_anchor), "top") if shp.text_frame.vertical_anchor is not None else "top"
                    except Exception:
                        item["valign"] = "top"
                if "img" in item or "fill" in item or "line" in item or "runs" in item:
                    shapes.append(item)
            except Exception:
                continue
        slides_out.append({"shapes": shapes})

    print(json.dumps({
        "w_emu": int(W), "h_emu": int(H),
        "aspect": round(W / H, 4),
        "n_slides": len(slides_out),
        "slides": slides_out,
    }, ensure_ascii=False))


# ----------------------------------------------------------------------------
# generate
# ----------------------------------------------------------------------------
def cmd_generate(spec_path):
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)

    template = spec["template"]
    output = spec["output"]
    slides_spec = spec.get("slides", [])

    prs = Presentation(template)
    lmap = layout_map(prs)
    n_original = len(prs.slides._sldIdLst)

    built = 0
    for s in slides_spec:
        if "clone_slide" in s and s["clone_slide"] is not None:
            idx = int(s["clone_slide"])
            new_slide = duplicate_slide(prs, idx)
            pairs = [(r.get("find", ""), r.get("with", ""))
                     for r in s.get("replace", [])]
            if pairs:
                replace_text_in_slide(new_slide, pairs)
            built += 1
        else:
            name = (s.get("from_layout") or "").strip().upper()
            layout = lmap.get(name)
            if layout is None:
                # Fallback: layout BLANK nếu có, không thì layout đầu tiên.
                layout = lmap.get("BLANK") or next(iter(lmap.values()))
            slide = prs.slides.add_slide(layout)
            title = s.get("title")
            subtitle = s.get("subtitle")
            body = s.get("body")
            body_right = s.get("body_right")
            body_phs = []
            for ph in slide.placeholders:
                t = ph.placeholder_format.type
                if t in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE) and title is not None:
                    set_placeholder_text(ph, title)
                elif t == PP_PLACEHOLDER.SUBTITLE and subtitle is not None:
                    set_placeholder_text(ph, subtitle)
                elif t == PP_PLACEHOLDER.BODY:
                    body_phs.append(ph)
            if body_phs:
                if body is not None:
                    if isinstance(body, list):
                        set_placeholder_bullets(body_phs[0], body)
                    else:
                        set_placeholder_text(body_phs[0], body)
                if body_right is not None and len(body_phs) > 1:
                    if isinstance(body_right, list):
                        set_placeholder_bullets(body_phs[1], body_right)
                    else:
                        set_placeholder_text(body_phs[1], body_right)
            built += 1

    # Xoá các slide mẫu gốc -> deck chỉ còn slide do spec tạo, đúng thứ tự.
    if not spec.get("keep_template_slides", False):
        delete_slides(prs, range(0, n_original))

    prs.save(output)

    import os
    size = os.path.getsize(output)
    print(json.dumps({
        "path": output,
        "size": size,
        "n_slides": len(prs.slides._sldIdLst),
        "built": built,
    }, ensure_ascii=False))


# ----------------------------------------------------------------------------
# images — ghép 1 ảnh / slide thành .pptx (dùng cho "HTML deck -> pptx")
# ----------------------------------------------------------------------------
def cmd_images(spec_path):
    import os
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    images = spec["images"]
    output = spec["output"]
    w = Inches(spec.get("width_in", 13.333))
    h = Inches(spec.get("height_in", 7.5))

    prs = Presentation()
    prs.slide_width = w
    prs.slide_height = h
    blank = prs.slide_layouts[6]  # 'Blank' trong template mặc định
    for img in images:
        slide = prs.slides.add_slide(blank)
        slide.shapes.add_picture(img, 0, 0, width=w, height=h)
    prs.save(output)
    print(json.dumps({
        "path": output,
        "size": os.path.getsize(output),
        "n_slides": len(images),
    }, ensure_ascii=False))


# ----------------------------------------------------------------------------
# native — dựng lại HTML deck thành slide NATIVE (shape/textbox thật, sửa được).
# Nhận spec do DOM-walker (html-to-pptx.ts) trích ra: mỗi slide gồm boxes (nền/
# viền), texts (textbox), images. Toạ độ tính bằng px theo viewport slide_w/h_px,
# scale tuyến tính sang EMU của slide (mặc định 13.333 x 7.5 in = 16:9).
# ----------------------------------------------------------------------------
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor
from pptx.util import Pt

_ALIGN = {
    "left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER,
    "right": PP_ALIGN.RIGHT, "justify": PP_ALIGN.JUSTIFY,
}
_ANCHOR = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}


def _hex(c):
    """'#RRGGBB' -> RGBColor; trả None nếu không hợp lệ."""
    if not c:
        return None
    s = c.lstrip("#")
    if len(s) != 6:
        return None
    try:
        return RGBColor(int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return None


def _add_outer_shadow(shape, sh):
    """Inject a CSS-like outer drop shadow (box-shadow) into a shape's spPr.
    sh: {dx, dy, blur, color '#RRGGBB', alpha 0..1}. No-op if invalid."""
    if not sh:
        return
    hexv = (sh.get("color") or "").lstrip("#")
    if len(hexv) != 6:
        return
    import math
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import qn, nsdecls
    # spread ÂM (vd -10px) làm shadow CO lại, gọn về phía offset thay vì phồng
    # quanh box. PowerPoint outerShdw không có spread -> xấp xỉ bằng cách trừ
    # spread vào blurRad cho shadow tighter, hướng rõ hơn.
    spread = float(sh.get("spread", 0) or 0)
    blur = int(max(0.0, float(sh.get("blur", 0) or 0) + spread) * 9525)   # px -> EMU
    dx = float(sh.get("dx", 0) or 0)
    dy = float(sh.get("dy", 0) or 0)
    dist = int(math.hypot(dx, dy) * 9525)
    ang = int((math.degrees(math.atan2(dy, dx)) % 360) * 60000)  # 60000ths deg
    alpha = int(max(0.0, min(1.0, float(sh.get("alpha", 1) or 1))) * 100000)
    spPr = shape._element.spPr
    for el in spPr.findall(qn("a:effectLst")):
        spPr.remove(el)
    xml = (
        '<a:effectLst %s>'
        '<a:outerShdw blurRad="%d" dist="%d" dir="%d" rotWithShape="0">'
        '<a:srgbClr val="%s"><a:alpha val="%d"/></a:srgbClr>'
        '</a:outerShdw></a:effectLst>'
    ) % (nsdecls("a"), blur, dist, ang, hexv.upper(), alpha)
    spPr.append(parse_xml(xml))


def _add_transition(slide, dur_ms=650):
    """Fade nhẹ khi chuyển slide. p14:dur cho PowerPoint 2010+ (mượt, đặt ms),
    fallback <p:transition spd> cho bản cũ. Inject vào <p:sld> đúng vị trí schema."""
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import qn
    sld = slide._element
    for el in sld.findall(qn("p:transition")):
        sld.remove(el)
    xml = (
        '<mc:AlternateContent '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">'
        '<mc:Choice Requires="p14">'
        '<p:transition spd="slow" p14:dur="%d"><p:fade/></p:transition>'
        '</mc:Choice>'
        '<mc:Fallback>'
        '<p:transition spd="med"><p:fade/></p:transition>'
        '</mc:Fallback>'
        '</mc:AlternateContent>'
    ) % int(dur_ms)
    elem = parse_xml(xml)
    ref = sld.find(qn("p:clrMapOvr"))
    if ref is None:
        ref = sld.find(qn("p:cSld"))
    if ref is not None:
        ref.addnext(elem)
    else:
        sld.append(elem)


def _add_reveal_anim(slide, pairs):
    """Entrance theo ĐÚNG tham số reveal HTML: mỗi shape fade (+trượt lên nếu rise)
    với delay/dur RIÊNG đọc từ transition-delay/duration của Aria. Auto chạy khi vào
    slide (withEffect + delay tuyệt đối = stagger), click = sang slide kế. pairs =
    list (spec{d,dur,rise}, spid). Lỗi XML -> bỏ qua (file vẫn hợp lệ, chỉ mất anim)."""
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import qn
    pairs = [(s, sp) for (s, sp) in pairs if s]
    if not pairs:
        return
    pairs.sort(key=lambda p: p[0].get("d", 0) or 0)
    sld = slide._element
    for el in sld.findall(qn("p:timing")):
        sld.remove(el)
    cid = [3]
    def nid():
        cid[0] += 1
        return cid[0]
    eff_xml = []
    for i, (spec, spid) in enumerate(pairs):
        delay = int(spec.get("d", 0) or 0)
        dur = int(spec.get("dur", 500) or 500)
        rise = bool(spec.get("rise"))
        node_type = "afterEffect" if i == 0 else "withEffect"
        eff_id, set_id, fade_id = nid(), nid(), nid()
        rise_xml = ""
        if rise:
            rise_id = nid()
            rise_xml = (
                '<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base">'
                '<p:cTn id="%d" dur="%d" fill="hold"/>'
                '<p:tgtEl><p:spTgt spid="%d"/></p:tgtEl>'
                '<p:attrNameLst><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr>'
                '<p:tavLst><p:tav tm="0"><p:val><p:fltVal val="0.028"/></p:val></p:tav>'
                '<p:tav tm="100000"><p:val><p:fltVal val="0"/></p:val></p:tav></p:tavLst></p:anim>'
                % (rise_id, dur, spid)
            )
        eff_xml.append(
            '<p:par><p:cTn id="%d" presetID="10" presetClass="entr" presetSubtype="0" '
            'fill="hold" grpId="0" nodeType="%s">'
            '<p:stCondLst><p:cond delay="%d"/></p:stCondLst>'
            '<p:childTnLst>'
            '<p:set><p:cBhvr>'
            '<p:cTn id="%d" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>'
            '<p:tgtEl><p:spTgt spid="%d"/></p:tgtEl>'
            '<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>'
            '</p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
            '<p:animEffect transition="in" filter="fade"><p:cBhvr>'
            '<p:cTn id="%d" dur="%d"/><p:tgtEl><p:spTgt spid="%d"/></p:tgtEl>'
            '</p:cBhvr></p:animEffect>'
            '%s'
            '</p:childTnLst></p:cTn></p:par>'
            % (eff_id, node_type, delay, set_id, spid, fade_id, dur, spid, rise_xml)
        )
    xml = (
        '<p:timing xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        '<p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">'
        '<p:childTnLst><p:seq concurrent="1" nextAc="seek">'
        '<p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
        '<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst>'
        '<p:childTnLst>' + "".join(eff_xml) + '</p:childTnLst></p:cTn></p:par>'
        '</p:childTnLst></p:cTn>'
        '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
        '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>'
        '</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
    )
    sld.append(parse_xml(xml))


def _set_per_corner_geom(shape, w, h, corners):
    """Thay geometry của shape bằng rounded-rect có bán kính RIÊNG từng góc.
    corners = [TL, TR, BR, BL] tính bằng EMU; mỗi góc clamp <= nửa cạnh ngắn.
    Dùng cho box CSS bo lệch (vd border-radius: 0 0 16px 16px = chỉ 2 góc dưới)."""
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import qn, nsdecls
    w, h = int(w), int(h)
    lim = min(w, h) / 2.0
    tl, tr, br, bl = [int(max(0, min(lim, c or 0))) for c in corners]
    # path đi theo chiều kim đồng hồ; arcTo dùng đơn vị 1/60000 độ.
    seg = ['<a:moveTo><a:pt x="%d" y="0"/></a:moveTo>' % tl,
           '<a:lnTo><a:pt x="%d" y="0"/></a:lnTo>' % (w - tr)]
    if tr > 0:
        seg.append('<a:arcTo wR="%d" hR="%d" stAng="-5400000" swAng="5400000"/>' % (tr, tr))
    seg.append('<a:lnTo><a:pt x="%d" y="%d"/></a:lnTo>' % (w, h - br))
    if br > 0:
        seg.append('<a:arcTo wR="%d" hR="%d" stAng="0" swAng="5400000"/>' % (br, br))
    seg.append('<a:lnTo><a:pt x="%d" y="%d"/></a:lnTo>' % (bl, h))
    if bl > 0:
        seg.append('<a:arcTo wR="%d" hR="%d" stAng="5400000" swAng="5400000"/>' % (bl, bl))
    seg.append('<a:lnTo><a:pt x="0" y="%d"/></a:lnTo>' % tl)
    if tl > 0:
        seg.append('<a:arcTo wR="%d" hR="%d" stAng="10800000" swAng="5400000"/>' % (tl, tl))
    seg.append('<a:close/>')
    xml = (
        '<a:custGeom %s><a:avLst/><a:gdLst/><a:ahLst/>'
        '<a:rect l="0" t="0" r="%d" b="%d"/>'
        '<a:pathLst><a:path w="%d" h="%d">%s</a:path></a:pathLst></a:custGeom>'
    ) % (nsdecls("a"), w, h, w, h, "".join(seg))
    spPr = shape._element.spPr
    for tag in ("a:prstGeom", "a:custGeom"):
        for el in spPr.findall(qn(tag)):
            spPr.remove(el)
    geom = parse_xml(xml)
    xfrm = spPr.find(qn("a:xfrm"))   # geometry phải đứng ngay sau xfrm trong schema
    if xfrm is not None:
        xfrm.addnext(geom)
    else:
        spPr.insert(0, geom)


def _set_accent_band_geom(shape, w, h, side, t, R):
    """Thanh accent (border 1 cạnh) dạng DẢI cong ÔM theo góc bo của card, THON
    NHỎ DẦN về 0 ở hai đầu góc — đúng cách trình duyệt vẽ border-top bo góc, cho
    cảm giác mềm/đổ bóng. Cạnh NGOÀI = cung TRÒN bán kính R; cạnh TRONG = cung
    ELIP cùng tâm (rút ngắn 1 trục đi t) -> giữa cạnh dày t, hai đầu góc dày 0.
    side in top/bottom/left/right; bbox = nguyên card. w,h,t,R tính bằng EMU."""
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import qn, nsdecls
    w, h = int(w), int(h)
    R = int(max(1, min(R, min(w, h) / 2.0)))
    t = int(max(1, min(t, R)))
    ri = max(0, R - t)  # trục elip trong bị rút theo bề dày viền
    A = 5400000         # 90° (đơn vị 1/60000 độ)
    H180 = 10800000     # 180°

    def mv(x, y):
        return '<a:moveTo><a:pt x="%d" y="%d"/></a:moveTo>' % (int(x), int(y))

    def ln(x, y):
        return '<a:lnTo><a:pt x="%d" y="%d"/></a:lnTo>' % (int(x), int(y))

    def arc(wr, hr, ang0, dang):
        return '<a:arcTo wR="%d" hR="%d" stAng="%d" swAng="%d"/>' % (wr, hr, ang0, dang)

    # Mỗi side: cung ngoài tròn (R,R), cung trong elip (trục dọc/ngang = ri tuỳ
    # cạnh nào dày). Hai đầu cung ngoài & trong gặp nhau tại điểm góc -> dày 0.
    if side == "top":
        seg = [mv(0, R), arc(R, R, H180, A), ln(w - R, 0), arc(R, R, -A, A),
               arc(R, ri, 0, -A), ln(R, t), arc(R, ri, -A, -A)]
    elif side == "bottom":
        seg = [mv(0, h - R), arc(R, R, H180, -A), ln(w - R, h), arc(R, R, A, -A),
               arc(R, ri, 0, A), ln(R, h - t), arc(R, ri, A, A)]
    elif side == "left":
        seg = [mv(R, 0), arc(R, R, -A, -A), ln(0, h - R), arc(R, R, H180, -A),
               arc(ri, R, A, A), ln(t, R), arc(ri, R, H180, A)]
    else:  # right
        seg = [mv(w - R, 0), arc(R, R, -A, A), ln(w, h - R), arc(R, R, 0, A),
               arc(ri, R, A, -A), ln(w - t, R), arc(ri, R, 0, -A)]
    seg.append('<a:close/>')

    xml = (
        '<a:custGeom %s><a:avLst/><a:gdLst/><a:ahLst/>'
        '<a:rect l="0" t="0" r="%d" b="%d"/>'
        '<a:pathLst><a:path w="%d" h="%d">%s</a:path></a:pathLst></a:custGeom>'
    ) % (nsdecls("a"), w, h, w, h, "".join(seg))
    spPr = shape._element.spPr
    for tag in ("a:prstGeom", "a:custGeom"):
        for el in spPr.findall(qn(tag)):
            spPr.remove(el)
    geom = parse_xml(xml)
    xfrm = spPr.find(qn("a:xfrm"))
    if xfrm is not None:
        xfrm.addnext(geom)
    else:
        spPr.insert(0, geom)


def _apply_solid_alpha(solidfill_el, alpha):
    """Thêm <a:alpha> vào <a:srgbClr> trong 1 <a:solidFill> -> màu BÁN TRONG SUỐT
    (cho fill/viền rgba). No-op nếu alpha ~ đặc hoặc không tìm thấy phần tử."""
    if solidfill_el is None or alpha is None or alpha >= 0.985:
        return
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import nsdecls
    clr = solidfill_el.find(qn("a:srgbClr"))
    if clr is None:
        return
    for old in clr.findall(qn("a:alpha")):
        clr.remove(old)
    val = int(max(0.0, min(1.0, alpha)) * 100000)
    clr.append(parse_xml('<a:alpha %s val="%d"/>' % (nsdecls("a"), val)))


def _set_radial_fill(shape, c0_hex, c1_hex, fx, fy):
    """Đổ RADIAL gradient (path=circle) cho shape: c0 ở TÂM (fx,fy)% -> c1 ở rìa.
    Khớp CSS radial-gradient(... at fx% fy% ...). c0/c1 = 'RRGGBB'. fillToRect thu
    về điểm tâm bằng inset l/t/r/b (đơn vị 1/1000 %)."""
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import nsdecls
    fx = max(0.0, min(100.0, float(fx)))
    fy = max(0.0, min(100.0, float(fy)))
    l = int(round(fx * 1000)); r = int(round((100 - fx) * 1000))
    t = int(round(fy * 1000)); b = int(round((100 - fy) * 1000))
    xml = (
        '<a:gradFill %s rotWithShape="1"><a:gsLst>'
        '<a:gs pos="0"><a:srgbClr val="%s"/></a:gs>'
        '<a:gs pos="100000"><a:srgbClr val="%s"/></a:gs>'
        '</a:gsLst><a:path path="circle">'
        '<a:fillToRect l="%d" t="%d" r="%d" b="%d"/></a:path></a:gradFill>'
    ) % (nsdecls("a"), c0_hex.upper(), c1_hex.upper(), l, t, r, b)
    spPr = shape._element.spPr
    for tag in ("a:noFill", "a:solidFill", "a:gradFill", "a:blipFill",
                "a:pattFill", "a:grpFill"):
        for el in spPr.findall(qn(tag)):
            spPr.remove(el)
    gf = parse_xml(xml)
    # Fill phải nằm SAU geometry và TRƯỚC ln/effectLst (shadow.inherit=False đã
    # chèn <a:effectLst/> nên append cuối sẽ sai schema -> PowerPoint bỏ qua fill).
    geom = spPr.find(qn("a:custGeom"))
    if geom is None:
        geom = spPr.find(qn("a:prstGeom"))
    if geom is None:
        geom = spPr.find(qn("a:xfrm"))
    if geom is not None:
        geom.addnext(gf)
    else:
        spPr.insert(0, gf)


def cmd_native(spec_path):
    import os
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)

    output = spec["output"]
    autofit_mode = spec.get("autofit", "shrink")  # "none" = giữ pt, không co chữ
    trans = spec.get("transition", "none")         # "fade" = fade nhẹ khi chuyển slide
    anim_mode = spec.get("anim", "none")            # "reveal" = entrance fade+stagger
    vw = float(spec.get("slide_w_px", 1280))
    vh = float(spec.get("slide_h_px", 720))
    slide_w = Inches(spec.get("width_in", 13.333))
    slide_h = Inches(spec.get("height_in", 7.5))
    sx = slide_w / vw   # EMU per px (ngang)
    sy = slide_h / vh   # EMU per px (dọc)

    def X(px):
        return Emu(int(round(px * sx)))

    def Y(px):
        return Emu(int(round(px * sy)))

    prs = Presentation()
    prs.slide_width = slide_w
    prs.slide_height = slide_h
    blank = prs.slide_layouts[6]

    n_box = n_text = n_img = 0
    for s in spec.get("slides", []):
        slide = prs.slides.add_slide(blank)
        anim_pairs = []  # (reveal_group_index, shape_id) cho entrance animation

        # SLIDE BACKGROUND IMAGE — added first = back-most, so native text/shapes
        # render on top and stay editable. python-pptx dedups identical image parts,
        # so the same artwork is embedded once for the whole deck.
        _bg = s.get("bg")
        if _bg and os.path.exists(_bg):
            slide.shapes.add_picture(_bg, 0, 0, width=slide_w, height=slide_h)
            n_img += 1

        # 1) BOXES (nền/viền) — vẽ theo thứ tự DOM để con đè lên cha; nhưng dải
        # ACCENT (border 1 cạnh, kể cả pseudo-bar bị card overflow:hidden clip) vẽ
        # SAU CÙNG để luôn nằm TRÊN card cùng bbox (không bị card trắng đè mất).
        for b in sorted(s.get("boxes", []), key=lambda bx: 1 if bx.get("accent") else 0):
            w = max(1, b.get("w", 0))
            h = max(1, b.get("h", 0))
            radius = b.get("radius", 0) or 0
            corners = b.get("corners")  # [TL,TR,BR,BL] px khi bo góc KHÔNG đều
            accent = b.get("accent")    # {side,t,r} = dải accent cong ôm góc card
            per_corner = (
                bool(corners) and not b.get("ellipse")
                and any((c or 0) > 0.5 for c in corners)
                and not all(abs((c or 0) - (corners[0] or 0)) < 0.6 for c in corners)
            )
            if b.get("ellipse"):
                shp_kind = MSO_SHAPE.OVAL
            elif radius > 0.5 and not per_corner and not accent:
                shp_kind = MSO_SHAPE.ROUNDED_RECTANGLE
            else:
                shp_kind = MSO_SHAPE.RECTANGLE
            shp = slide.shapes.add_shape(shp_kind, X(b["x"]), Y(b["y"]), X(w), Y(h))
            shp.shadow.inherit = False
            if accent:
                # dải accent đi vòng 2 góc bo của card -> custom geometry
                try:
                    _set_accent_band_geom(shp, int(X(w)), int(Y(h)), accent.get("side"),
                                          int(round((accent.get("t", 4) or 4) * sx)),
                                          int(round((accent.get("r", 0) or 0) * sx)))
                except Exception:
                    pass
            elif per_corner:
                # bo riêng từng góc (vd chỉ 2 góc dưới) -> custom geometry
                try:
                    _set_per_corner_geom(shp, int(X(w)), int(Y(h)),
                                         [int(round((c or 0) * sx)) for c in corners])
                except Exception:
                    pass
            elif radius > 0.5:
                # bo góc đều: adjustment 0..~0.5 theo tỉ lệ radius/cạnh ngắn
                try:
                    short = min(w, h)
                    shp.adjustments[0] = max(0.0, min(0.5, radius / short)) if short else 0.0
                except Exception:
                    pass
            # fill
            spPr = shp._element.spPr
            grad = b.get("gradient")
            fill_hex = b.get("fill")
            fa = b.get("fill_alpha", 1)
            if grad and len(grad.get("colors", [])) >= 2:
                c0, c1 = _hex(grad["colors"][0]), _hex(grad["colors"][-1])
                if c0 and c1:
                    if grad.get("type") == "radial":
                        try:
                            _set_radial_fill(shp, str(c0), str(c1),
                                             grad.get("fx", 50), grad.get("fy", 50))
                        except Exception:
                            shp.fill.solid()
                            shp.fill.fore_color.rgb = c0
                    else:
                        try:
                            shp.fill.gradient()
                            stops = shp.fill.gradient_stops
                            stops[0].color.rgb = c0
                            stops[-1].color.rgb = c1
                            try:
                                shp.fill.gradient_angle = float(grad.get("angle", 90))
                            except Exception:
                                pass
                        except Exception:
                            shp.fill.solid()
                            shp.fill.fore_color.rgb = c0
                else:
                    shp.fill.background()
            elif fill_hex and fa > 0.02:
                rgb = _hex(fill_hex)
                if rgb:
                    shp.fill.solid()
                    shp.fill.fore_color.rgb = rgb
                    # rgba() bán trong suốt -> giữ độ mờ (vd card rgba(255,255,255,.04)
                    # trên nền tối). Trước đây bỏ alpha -> box thành TRẮNG ĐẶC.
                    _apply_solid_alpha(spPr.find(qn("a:solidFill")), fa)
                else:
                    shp.fill.background()
            else:
                shp.fill.background()
            # viền
            ln_hex = b.get("line")
            lw = b.get("line_w", 0) or 0
            la = b.get("line_alpha", 1)
            if ln_hex and lw > 0.3:
                rgb = _hex(ln_hex)
                if rgb:
                    shp.line.color.rgb = rgb
                    shp.line.width = Emu(int(round(lw * sy)))
                    ln_el = spPr.find(qn("a:ln"))
                    if ln_el is not None:
                        _apply_solid_alpha(ln_el.find(qn("a:solidFill")), la)
                else:
                    shp.line.fill.background()
            else:
                shp.line.fill.background()
            _add_outer_shadow(shp, b.get("shadow"))
            if b.get("anim") is not None:
                anim_pairs.append((b["anim"], shp.shape_id))
            n_box += 1

        # 2) IMAGES
        for im in s.get("images", []):
            p = im.get("path")
            if p and os.path.exists(p):
                try:
                    pic = slide.shapes.add_picture(p, X(im["x"]), Y(im["y"]),
                                                   X(max(1, im["w"])), Y(max(1, im["h"])))
                    if im.get("anim") is not None:
                        anim_pairs.append((im["anim"], pic.shape_id))
                    n_img += 1
                except Exception:
                    pass

        # 3) TEXTS (textbox đè trên cùng). Mỗi text có `runs` (giữ định dạng theo
        #    từng đoạn chữ); {"br": true} = xuống dòng. Fallback `text` nếu thiếu.
        for t in s.get("texts", []):
            tb = slide.shapes.add_textbox(X(t["x"]), Y(t["y"]),
                                          X(max(1, t["w"])), Y(max(1, t["h"])))
            if t.get("anim") is not None:
                anim_pairs.append((t["anim"], tb.shape_id))
            tf = tb.text_frame
            tf.word_wrap = True
            # "Shrink text on overflow": nếu font bị thay (rộng hơn) khiến chữ
            # quá khổ, PowerPoint tự co lại cho khỏi tràn slide.
            try:
                tf.auto_size = (MSO_AUTO_SIZE.NONE if autofit_mode == "none"
                                else MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE)
            except Exception:
                pass
            for m in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
                setattr(tf, m, Emu(0))
            tf.vertical_anchor = _ANCHOR.get(t.get("valign", "top"), MSO_ANCHOR.TOP)
            align = _ALIGN.get(t.get("align", "left"), PP_ALIGN.LEFT)
            lp = t.get("line_pct")

            runs = t.get("runs")
            if not runs:
                runs = [{"text": ln} if i == 0 else {"br": True, "text": ln}
                        for i, ln in enumerate(str(t.get("text", "")).split("\n"))]

            # Line-spacing: đặt dạng ĐIỂM tuyệt đối (spcPts) = size * line_pct,
            # KHÔNG dùng phần trăm (spcPct). PowerPoint render spcPct ở textbox
            # chữ nhỏ/đa dòng bị NHÂN ĐÔI (ghost lệch dòng) — điểm tuyệt đối sạch.
            _ls_sizes = [float(r["size_pt"]) for r in runs if r.get("size_pt")]
            if not _ls_sizes and t.get("size_pt"):
                _ls_sizes = [float(t["size_pt"])]
            _ls_pt = (max(_ls_sizes) * float(lp)) if (lp and _ls_sizes) else None

            def _new_para(first):
                p = tf.paragraphs[0] if first else tf.add_paragraph()
                p.alignment = align
                if lp:
                    try:
                        p.line_spacing = Pt(_ls_pt) if _ls_pt else float(lp)
                    except Exception:
                        pass
                return p

            para = _new_para(True)
            started = False
            for rn in runs:
                if rn.get("br"):
                    para = _new_para(False)
                    started = False
                    if not rn.get("text"):
                        continue
                txt = rn.get("text", "")
                if txt == "" and not rn.get("br"):
                    continue
                r = para.add_run()
                r.text = txt
                started = True
                f = r.font
                sz = rn.get("size_pt", t.get("size_pt"))
                if sz:
                    f.size = Pt(float(sz))
                fam = rn.get("font", t.get("font"))
                if fam:
                    f.name = fam
                spc = rn.get("spc", t.get("spc"))
                if spc:
                    try:
                        r._r.get_or_add_rPr().set("spc", str(int(spc)))
                    except Exception:
                        pass
                f.bold = bool(rn.get("bold", t.get("bold")))
                f.italic = bool(rn.get("italic", t.get("italic")))
                rgb = _hex(rn.get("color", t.get("color")))
                if rgb:
                    f.color.rgb = rgb
            n_text += 1

        if trans != "none":
            try:
                _add_transition(slide)
            except Exception:
                pass

        if anim_mode == "reveal" and anim_pairs:
            try:
                _add_reveal_anim(slide, anim_pairs)
            except Exception:
                pass

    prs.save(output)

    n_fonts = 0
    if spec.get("fonts"):
        try:
            n_fonts = embed_fonts(output, spec["fonts"])
        except Exception:
            n_fonts = 0  # nhúng lỗi -> deck vẫn xuất bình thường

    print(json.dumps({
        "path": output,
        "size": os.path.getsize(output),
        "n_slides": len(prs.slides._sldIdLst),
        "boxes": n_box, "texts": n_text, "images": n_img,
        "fonts_embedded": n_fonts,
    }, ensure_ascii=False))


# ----------------------------------------------------------------------------
# embed_fonts — nhúng TTF vào .pptx đã lưu (PowerPoint embeddedFontLst). Thêm:
#   - part ppt/fonts/fontN.fntdata (bytes TTF)
#   - Relationship type .../font trong presentation.xml.rels
#   - Default Extension fntdata trong [Content_Types].xml
#   - <p:embeddedFontLst> + attrs embedTrueTypeFonts/saveSubsetFonts
# fonts: list[{family, regular, bold, italic, boldItalic}] (path hoặc None).
# ----------------------------------------------------------------------------
def embed_fonts(pptx_path, fonts):
    import os
    import zipfile
    import shutil
    from lxml import etree

    P = "http://schemas.openxmlformats.org/presentationml/2006/main"
    R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    CT = "http://schemas.openxmlformats.org/package/2006/content-types"
    REL = "http://schemas.openxmlformats.org/package/2006/relationships"
    RT_FONT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
    SLOTS = ("regular", "bold", "italic", "boldItalic")

    used = [(f["family"], {s: f.get(s) for s in SLOTS})
            for f in fonts if any(f.get(s) for s in SLOTS)]
    if not used:
        return 0

    with zipfile.ZipFile(pptx_path, "r") as z:
        data = {n: z.read(n) for n in z.namelist()}

    # 1) [Content_Types].xml
    ct = etree.fromstring(data["[Content_Types].xml"])
    if not any(d.get("Extension", "").lower() == "fntdata"
               for d in ct.findall("{%s}Default" % CT)):
        d = etree.SubElement(ct, "{%s}Default" % CT)
        d.set("Extension", "fntdata")
        d.set("ContentType", "application/x-fontdata")
    data["[Content_Types].xml"] = etree.tostring(
        ct, xml_declaration=True, encoding="UTF-8", standalone=True)

    # 2) presentation.xml.rels + font parts
    rels_path = "ppt/_rels/presentation.xml.rels"
    rels = etree.fromstring(data[rels_path])
    maxid = 0
    for rel in rels.findall("{%s}Relationship" % REL):
        rid = rel.get("Id", "")
        if rid.startswith("rId") and rid[3:].isdigit():
            maxid = max(maxid, int(rid[3:]))

    font_idx = 0
    fam_rids = []
    for family, slots in used:
        rid_map = {}
        for slot in SLOTS:
            p = slots.get(slot)
            if not p or not os.path.exists(p):
                continue
            font_idx += 1
            part = "fonts/font%d.fntdata" % font_idx
            with open(p, "rb") as fh:
                data["ppt/" + part] = fh.read()
            maxid += 1
            rid = "rId%d" % maxid
            rel = etree.SubElement(rels, "{%s}Relationship" % REL)
            rel.set("Id", rid)
            rel.set("Type", RT_FONT)
            rel.set("Target", part)
            rid_map[slot] = rid
        if rid_map:
            fam_rids.append((family, rid_map))
    data[rels_path] = etree.tostring(
        rels, xml_declaration=True, encoding="UTF-8", standalone=True)

    # 3) presentation.xml: attrs + embeddedFontLst (đúng schema order)
    pres = etree.fromstring(data["ppt/presentation.xml"])
    pres.set("embedTrueTypeFonts", "1")
    pres.set("saveSubsetFonts", "0")
    lst = etree.SubElement(pres, "{%s}embeddedFontLst" % P)
    for family, rid_map in fam_rids:
        ef = etree.SubElement(lst, "{%s}embeddedFont" % P)
        fn = etree.SubElement(ef, "{%s}font" % P)
        fn.set("typeface", family)
        for slot in SLOTS:
            if slot in rid_map:
                e = etree.SubElement(ef, "{%s}%s" % (P, slot))
                e.set("{%s}id" % R, rid_map[slot])
    pres.remove(lst)
    children = list(pres)

    def idx_of(local):
        tag = "{%s}%s" % (P, local)
        for i, c in enumerate(children):
            if c.tag == tag:
                return i
        return -1
    after = max(idx_of("notesSz"), idx_of("sldSz"))
    pres.insert(after + 1 if after >= 0 else len(children), lst)
    data["ppt/presentation.xml"] = etree.tostring(
        pres, xml_declaration=True, encoding="UTF-8", standalone=True)

    # 4) ghi lại zip (đặt [Content_Types].xml đầu tiên)
    tmp = pptx_path + ".tmp"
    order = ["[Content_Types].xml"] + [n for n in data if n != "[Content_Types].xml"]
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n in order:
            z.writestr(n, data[n])
    shutil.move(tmp, pptx_path)
    return font_idx


# ----------------------------------------------------------------------------
def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: pptx_gen.py inspect|generate <arg>"}))
        sys.exit(2)
    cmd, arg = sys.argv[1], sys.argv[2]
    try:
        if cmd == "inspect":
            cmd_inspect(arg)
        elif cmd == "outline":
            cmd_outline(arg)
        elif cmd == "preview":
            cmd_preview(arg)
        elif cmd == "generate":
            cmd_generate(arg)
        elif cmd == "images":
            cmd_images(arg)
        elif cmd == "native":
            cmd_native(arg)
        else:
            print(json.dumps({"error": f"unknown command: {cmd}"}))
            sys.exit(2)
    except Exception as e:
        import traceback
        print(json.dumps({"error": f"{type(e).__name__}: {e}",
                          "trace": traceback.format_exc()}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
