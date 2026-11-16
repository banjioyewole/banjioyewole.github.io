// Renders new-modality's on-screen text to transparent PNGs, in the app's own faces, for the
// redaction project globe (js/redaction-project-globe.js):
//
//   the HUD's labels over the globe, in SF Compact Display Semibold at the sizes RecordingHUD.swift
//   sets them (49pt and 22pt), and the line at the foot in SF Mono.
//
// Pictures of the text, not the fonts: Apple's licence covers the SF font files, which the public
// site can't serve. Run on a Mac with SF Compact installed (/Library/Fonts):
//
//   swift tools/render_new_modality_text.swift
//
// Writes assets/new_modality/text/*.png and prints each image's size in points.
import AppKit

let scale: CGFloat = 4                       // pixels per point: sharp at 4x the sizes below
let out = URL(fileURLWithPath: "assets/new_modality/text", isDirectory: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

let amber = NSColor(srgbRed: 1, green: 191 / 255, blue: 0, alpha: 1)   // RecordingHUD.startingMicColor
guard let title = NSFont(name: "SFCompactDisplay-Semibold", size: 49),
      let detail = NSFont(name: "SFCompactDisplay-Semibold", size: 22) else {
    fatalError("SF Compact Display Semibold isn't installed")
}
// The caption: SF Mono, set at 20pt in a 1.7 line, as the page's CSS sets it.
// The system's monospaced face is SF Mono, under a private name when it isn't installed as SFMono.
let mono = NSFont(name: "SFMono-Regular", size: 20) ?? NSFont.monospacedSystemFont(ofSize: 20, weight: .regular)
print("caption face: \(mono.fontName)")

/// One line, drawn with its baseline where a box `height` tall would put it (the font's own
/// ascender and descender centred in it, as CSS centres a line), `pad` points either side.
func render(_ name: String, _ text: NSAttributedString, font: NSFont, height: CGFloat? = nil, pad: CGFloat = 1) {
    let natural = ceil(font.ascender - font.descender) + 2
    let h = height ?? natural
    let w = ceil(text.size().width) + 2 * pad
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(w * scale), pixelsHigh: Int(h * scale),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: w, height: h)
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    ctx.shouldAntialias = true
    NSGraphicsContext.current = ctx
    let baseline = (h - (font.ascender - font.descender)) / 2 - font.descender
    text.draw(at: NSPoint(x: pad, y: baseline + font.descender))
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("\(name).png"))
    print("\(name).png  \(w) x \(h) pt")
}

func text(_ s: String, _ font: NSFont, tint: String? = nil) -> NSAttributedString {
    let a = NSMutableAttributedString(string: s, attributes: [.font: font, .foregroundColor: NSColor.white])
    if let tint, let r = s.range(of: tint) { a.addAttribute(.foregroundColor, value: amber, range: NSRange(r, in: s)) }
    return a
}

// The HUD's labels (RecordingHUD.title(for:) and detail(for:)).
render("hud-dictation", text("DICTATION", title), font: title)
render("hud-transcribing", text("TRANSCRIBING", title), font: title)
render("hud-starting", text("STARTING MIC", detail, tint: "STARTING MIC"), font: detail)
render("hud-listening", text("LISTENING", detail), font: detail)
render("hud-dictation-small", text("DICTATION", detail), font: detail)

// The line, one image a line, no padding, so each character is an equal share of the width and
// the page can reveal it a word at a time by clipping.
render("line-1", text("The mouse and keyboard are dead.", mono), font: mono, height: 34, pad: 0)
render("line-2", text("Long live new-modality.", mono), font: mono, height: 34, pad: 0)
