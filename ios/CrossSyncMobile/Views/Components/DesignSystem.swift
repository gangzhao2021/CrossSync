import SwiftUI

extension Color {
    static let crossSyncCyan = Color(red: 0.180, green: 0.722, blue: 1.000)
    static let crossSyncBlue = Color(red: 0.357, green: 0.424, blue: 1.000)
    static let crossSyncViolet = Color(red: 0.545, green: 0.361, blue: 0.965)
    static let crossSyncMagenta = Color(red: 0.941, green: 0.353, blue: 0.651)
    static let crossSyncGreen = Color(red: 0.224, green: 0.851, blue: 0.541)
    static let crossSyncSecondaryText = Color(red: 0.604, green: 0.655, blue: 0.741)
    static let crossSyncCardBorder = Color(red: 0.169, green: 0.227, blue: 0.314)
}

struct CrossSyncBackground: View {
    var body: some View {
        LinearGradient(
            colors: [
                Color(red: 0.067, green: 0.094, blue: 0.153),
                Color(red: 0.031, green: 0.051, blue: 0.094),
                Color(red: 0.047, green: 0.043, blue: 0.094)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .overlay(alignment: .topTrailing) {
            RadialGradient(
                colors: [Color.crossSyncCyan.opacity(0.12), .clear],
                center: .center,
                startRadius: 0,
                endRadius: 190
            )
            .frame(width: 380, height: 380)
            .offset(x: 120, y: 80)
        }
        .ignoresSafeArea()
    }
}

struct CrossSyncCard<Content: View>: View {
    let accent: Color
    let content: Content

    init(accent: Color = .crossSyncCardBorder, @ViewBuilder content: () -> Content) {
        self.accent = accent
        self.content = content()
    }

    var body: some View {
        content
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(
                    colors: [
                        Color(red: 0.082, green: 0.114, blue: 0.173).opacity(0.98),
                        Color(red: 0.063, green: 0.082, blue: 0.129).opacity(0.94)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                in: RoundedRectangle(cornerRadius: 24, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(accent.opacity(0.78), lineWidth: 1)
            }
    }
}

struct PrimaryActionLabel: View {
    let title: String
    var success = false

    var body: some View {
        Text(title)
            .font(.headline)
            .fontWeight(.bold)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 56)
            .background(
                LinearGradient(
                    colors: success
                        ? [.crossSyncGreen, .crossSyncBlue]
                        : [.crossSyncCyan, .crossSyncBlue],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            .shadow(color: (success ? Color.crossSyncGreen : .crossSyncCyan).opacity(0.28), radius: 12, y: 6)
    }
}

struct AppHeader: View {
    let connected: Bool
    let computerName: String
    let action: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(LinearGradient(colors: [.crossSyncCyan, .crossSyncViolet], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 24, height: 24)
            Text("CrossSync")
                .font(.headline)
                .fontWeight(.bold)
            Spacer()
            Button(action: action) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(connected ? Color.crossSyncGreen : Color.crossSyncMagenta)
                        .frame(width: 8, height: 8)
                    Text(connected ? "\(computerName) 已连接" : "设置电脑")
                        .font(.caption2)
                        .fontWeight(.medium)
                        .lineLimit(1)
                }
                .foregroundStyle(connected ? Color.crossSyncGreen : Color.crossSyncMagenta)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(
                    (connected ? Color.crossSyncGreen : Color.crossSyncMagenta).opacity(0.09),
                    in: Capsule()
                )
                .overlay {
                    Capsule().stroke((connected ? Color.crossSyncGreen : Color.crossSyncMagenta).opacity(0.35))
                }
            }
            .buttonStyle(.plain)
        }
    }
}

struct ScreenTitle: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.title)
                .fontWeight(.bold)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(Color.crossSyncSecondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct StatusRow: View {
    let symbol: String
    let tint: Color
    let title: String
    let value: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 22)
            Text(title)
                .font(.subheadline)
                .fontWeight(.medium)
            Spacer()
            Text(value)
                .font(.footnote)
                .fontWeight(.medium)
                .foregroundStyle(tint)
        }
    }
}
