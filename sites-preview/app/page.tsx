"use client";

import { useRef, useState } from "react";

const transfers = [
  { name: "IMG_1234.HEIC", meta: "2.4 MB · 刚刚", icon: "photo.svg" },
  { name: "项目提案.pdf", meta: "1.8 MB · 2 分钟前", icon: "file-type-pdf.svg" },
];

function Icon({ name, alt = "" }: { name: string; alt?: string }) {
  return <img src={`/icons/${name}`} alt={alt} />;
}

export default function Home() {
  const [light, setLight] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [direction, setDirection] = useState<"computer" | "phone">("computer");
  const [selectedName, setSelectedName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const chooseFile = () => fileInput.current?.click();

  return (
    <main className={light ? "site light" : "site"}>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        multiple
        onChange={(event) => setSelectedName(event.target.files?.[0]?.name ?? "")}
      />

      <aside className="sidebar" aria-label="CrossSync 导航">
        <div className="brand"><img src="/app-icon.png" alt="CrossSync" /><strong>CrossSync</strong></div>
        <nav aria-label="传输方向">
          <button className={direction === "computer" ? "nav-item active" : "nav-item"} onClick={() => setDirection("computer")}>
            <Icon name="device-desktop.svg" /><span>发送到电脑</span>
          </button>
          <button className={direction === "phone" ? "nav-item active" : "nav-item"} onClick={() => { setDirection("phone"); chooseFile(); }}>
            <Icon name="device-mobile.svg" /><span>发送到 iPhone</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button className="manage" onClick={() => setDrawer(true)}><Icon name="folder.svg" /><span>文件管理</span></button>
          <button className="theme" aria-label="切换主题" onClick={() => setLight(!light)}><Icon name={light ? "sun.svg" : "moon.svg"} /></button>
        </div>
      </aside>

      <section className="workspace">
        <header className="statusbar">
          <span className="connected"><Icon name="device-desktop.svg" /> MacBookPro 已连接</span>
          <span className="divider" />
          <span className="security"><Icon name="shield-check.svg" /> 本地连接 · 未加密</span>
          <span className="divider" />
          <span className="caption">局域网直连，不经过云端</span>
        </header>

        <div className="content">
          <p className="eyebrow">IPHONE → COMPUTER</p>
          <h1>{direction === "computer" ? "发送到 MacBookPro" : "发送到 iPhone"}</h1>
          <div className="destination"><Icon name="device-desktop.svg" /><span>保存到</span><strong>/Users/ryan/Downloads/CrossSync</strong><button onClick={() => setDrawer(true)}>更改保存位置…</button></div>
          <p className="helper">手机传完后会直接出现在这个文件夹。</p>

          <button className="dropzone" onClick={chooseFile}>
            <span className="upload-icon"><Icon name="photo.svg" /></span>
            <strong>{selectedName ? `已选择：${selectedName}` : "选择照片或文件"}</strong>
            <span>拖放到这里也可以</span>
          </button>

          <section className="recent" aria-labelledby="recent-title">
            <div className="section-heading">
              <div><p className="eyebrow">COMPUTER</p><h2 id="recent-title">最近传输</h2></div>
              <div className="actions">
                <button aria-label="打开目录"><Icon name="folder-open.svg" /></button>
                <button aria-label="刷新"><Icon name="refresh.svg" /></button>
                <button onClick={() => setDrawer(true)}>管理</button>
              </div>
            </div>
            <div className="transfer-list">
              {transfers.map((item) => (
                <div className="transfer-row" key={item.name}>
                  <span className="file-icon"><Icon name={item.icon} /></span>
                  <span className="file-copy"><strong>{item.name}</strong><small>{item.meta}</small></span>
                  <span className="complete"><Icon name="circle-check.svg" /> 已完成</span>
                  <Icon name="chevron-right.svg" />
                </div>
              ))}
            </div>
          </section>
          <p className="preview-note">这是 CrossSync 的交互式设计预览；真实局域网文件传输需运行本地应用。</p>
        </div>
      </section>

      {drawer && <div className="backdrop" onClick={() => setDrawer(false)} />}
      <aside className={drawer ? "drawer open" : "drawer"} aria-hidden={!drawer}>
        <div className="drawer-head"><div><p className="eyebrow">TRANSFER SETTINGS</p><h2>文件管理与传输设置</h2></div><button aria-label="关闭" onClick={() => setDrawer(false)}><Icon name="x.svg" /></button></div>
        <p>管理发送方向、保存位置与文件校验选项。</p>
        <fieldset><legend>传输方向</legend><label><input type="radio" checked={direction === "computer"} onChange={() => setDirection("computer")} /> 到电脑</label><label><input type="radio" checked={direction === "phone"} onChange={() => setDirection("phone")} /> 到 iPhone</label></fieldset>
        <label className="check"><input type="checkbox" defaultChecked /> 完成后打开目录</label>
        <label className="check"><input type="checkbox" /> 按日期归档</label>
        <label className="check"><input type="checkbox" defaultChecked /> SHA-256 校验</label>
        <button className="primary" onClick={() => setDrawer(false)}>保存设置</button>
      </aside>
    </main>
  );
}
