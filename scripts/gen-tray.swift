#!/usr/bin/env swift
// 生成 macOS 菜单栏 template 托盘图标：assets/trayTemplate.png(22x22) / trayTemplate@2x.png(44x44)
// 规范：纯黑 + alpha 通道（形状外全透明），系统按菜单栏深/浅色自动着色；@2x 文件名供 Retina 自动加载。
// 用法: swift scripts/gen-tray.swift

import AppKit
import CoreText

// 粗体 "D" 字形路径构造 template 图：黑色填充，占画布高度 78%，居中
func makeTray(_ px: Int) -> NSBitmapImageRep {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                     isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else {
        fatalError("无法创建位图")
    }
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    // 清透明底
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: px, height: px).fill()

    // D 字形路径（先等比缩放到目标高度，再平移居中）
    let nsFont = NSFont.systemFont(ofSize: CGFloat(px), weight: .bold)
    let ctFont = CTFontCreateWithName(nsFont.fontName as CFString, CGFloat(px), nil)
    var chars: [UniChar] = Array("D".utf16)
    var glyphs = [CGGlyph](repeating: 0, count: chars.count)
    CTFontGetGlyphsForCharacters(ctFont, &chars, &glyphs, chars.count)
    guard var path = CTFontCreatePathForGlyph(ctFont, glyphs[0], nil) else {
        fatalError("无法获取字形路径")
    }
    var ink = path.boundingBox
    let scale = CGFloat(px) * 0.78 / ink.height
    var st = CGAffineTransform(scaleX: scale, y: scale)
    path = path.copy(using: &st)!
    ink = path.boundingBox
    var t = CGAffineTransform(translationX: CGFloat(px) / 2 - ink.midX,
                              y: CGFloat(px) / 2 - ink.midY)
    NSColor.black.setFill()
    NSBezierPath(cgPath: path.copy(using: &t)!).fill()

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

for (file, px) in [("assets/trayTemplate.png", 22), ("assets/trayTemplate@2x.png", 44)] {
    let rep = makeTray(px)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: file))
    print("已生成 \(file)（\(px)x\(px)）")
}
