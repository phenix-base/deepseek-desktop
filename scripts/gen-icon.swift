#!/usr/bin/env swift
// 生成应用图标 build/icon.png（1024x1024，AppKit 绘制）
// 深色圆角底（#0d1117）+ 蓝色渐变光效（#58a6ff）+ 白色居中文字 "DS"
// 产物作为 .icns 母版（见 iconutil 流程）与打包素材使用。
// 用法: swift scripts/gen-icon.swift [输出路径，默认 build/icon.png]

import AppKit
import CoreText

let W: CGFloat = 1024
let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build/icon.png"

func color(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

// 1024x1024 位图上下文（AppKit 左下原点，未翻转，1px 对应 1pt）
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                 isPlanar: false, colorSpaceName: .deviceRGB,
                                 bytesPerRow: 0, bitsPerPixel: 0) else {
    fatalError("无法创建位图上下文")
}
rep.size = NSSize(width: W, height: W)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let full = NSRect(x: 0, y: 0, width: W, height: W)

// 1) 深色圆角矩形底
let bg = NSBezierPath(roundedRect: full, xRadius: 228, yRadius: 228)
color(0x0d1117).setFill()
bg.fill()

// 以圆角矩形裁剪，保证光效/描边不溢出圆角外
bg.addClip()

// 2) 蓝色渐变光效：左上径向光晕 + 顶部竖直光带，营造"光从上方打下来"的层次
let halo = NSGradient(starting: color(0x58a6ff, 0.50), ending: color(0x58a6ff, 0.0))!
halo.draw(in: full, relativeCenterPosition: NSPoint(x: -0.30, y: 0.34))

let beam = NSGradient(starting: color(0x58a6ff, 0.20), ending: color(0x58a6ff, 0.0))!
beam.draw(from: NSPoint(x: W * 0.30, y: W * 0.92), to: NSPoint(x: W * 0.30, y: W * 0.40),
          options: [.drawsAfterEndingLocation])

// 3) 细描边，强化卡片质感
let border = NSBezierPath(roundedRect: NSRect(x: 3, y: 3, width: W - 6, height: W - 6),
                          xRadius: 226, yRadius: 226)
border.lineWidth = 3
color(0x58a6ff, 0.32).setStroke()
border.stroke()

// 4) 白色 "DS"：用字形路径构造并平移至画布中心，ink 精确居中、不依赖 draw(at:) 的坐标语义
var fontSize: CGFloat = 470
var glyphPath = CGMutablePath()
while true {
    let nsFont = NSFont.systemFont(ofSize: fontSize, weight: .bold)
    let ctFont = CTFontCreateWithName(nsFont.fontName as CFString, fontSize, nil)
    var chars: [UniChar] = Array("DS".utf16)
    var glyphs = [CGGlyph](repeating: 0, count: chars.count)
    CTFontGetGlyphsForCharacters(ctFont, &chars, &glyphs, chars.count)
    var advances = [CGSize](repeating: .zero, count: glyphs.count)
    CTFontGetAdvancesForGlyphs(ctFont, .horizontal, glyphs, &advances, glyphs.count)
    glyphPath = CGMutablePath()
    for (i, g) in glyphs.enumerated() {
        if let p = CTFontCreatePathForGlyph(ctFont, g, nil) {
            let dx = (0..<i).reduce(0.0) { $0 + advances[$1].width }
            glyphPath.addPath(p, transform: CGAffineTransform(translationX: dx, y: 0))
        }
    }
    if glyphPath.boundingBox.width <= W * 0.62 || fontSize < 200 { break }
    fontSize -= 10
}
let inkBox = glyphPath.boundingBox
var centerT = CGAffineTransform(translationX: W / 2 - inkBox.midX, y: W / 2 - inkBox.midY)
NSColor.white.setFill()
NSBezierPath(cgPath: glyphPath.copy(using: &centerT)!).fill()

NSGraphicsContext.restoreGraphicsState()

// 输出 PNG
guard let data = rep.representation(using: .png, properties: [:]) else {
    fatalError("PNG 编码失败")
}
try! data.write(to: URL(fileURLWithPath: outPath))
print("已生成 \(outPath)（字号 \(fontSize)）")
