import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSpaceMeteors } from "./space-meteors";
import type { SpaceEffectsSettings } from "./space-meteor-settings";

type Mode = "normal" | "shower";
const colorLabels = { cyan: "青蓝", blue: "冰蓝", violet: "淡紫", rose: "玫瑰", gold: "暖金" } as const;

function NumberSetting({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (value: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const invalid = draft.trim() === "" || !Number.isFinite(Number(draft)) || Number(draft) < min || Number(draft) > max;
  return <div className="space-number-setting"><label htmlFor={id}>{label}<small id={`${id}-unit`}>{unit}</small></label><div className="space-number-inputs">
    <input type="range" aria-label={`${label}滑块`} min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} />
    <input id={id} type="number" inputMode="decimal" aria-label={label} aria-describedby={`${id}-unit`} min={min} max={max} step={step} value={draft} aria-invalid={invalid} onChange={event => { const raw = event.target.value; setDraft(raw); const number = Number(raw); if (raw.trim() && Number.isFinite(number) && number >= min && number <= max) onChange(number); }} onBlur={() => setDraft(String(value))} />
  </div>{invalid && <small className="space-field-error">请输入 {min}～{max} {unit}；无效值不会保存。</small>}</div>;
}

function ToggleSetting({ label, checked, onChange, note }: { label: string; checked: boolean; onChange: (value: boolean) => void; note?: string }) {
  return <label className="space-checkbox-setting"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span>{label}{note && <small>{note}</small>}</span></label>;
}

export function SpaceMotionSettings({ enabled, reduced, onClose }: { enabled: boolean; reduced: boolean; onClose: () => void }) {
  const { settings, updateSettings, resetSettings, preview, stopPreview, previewMode, device, effective, storageAvailable } = useSpaceMeteors();
  const [tab, setTab] = useState<Mode | "other">("normal");
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const stop = useRef(stopPreview); stop.current = stopPreview;
  const titleId = useId(); const descriptionId = useId(); const panelId = useId();
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.showModal(); closeButton.current?.focus();
    return () => { stop.current(); node?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const updateMode = <M extends Mode, K extends keyof SpaceEffectsSettings[M]>(mode: M, key: K, value: SpaceEffectsSettings[M][K]) => updateSettings({ ...settings, [mode]: { ...settings[mode], [key]: value } });
  const updateOther = (key: keyof SpaceEffectsSettings["other"], value: boolean) => updateSettings({ ...settings, other: { ...settings.other, [key]: value } });
  const mode = tab === "other" ? "normal" : tab;
  const values = settings[mode];
  const number = (key: keyof typeof values, label: string, min: number, max: number, unit: string, step = 1) => <NumberSetting key={`${mode}-${key}`} label={label} value={values[key] as number} min={min} max={max} unit={unit} step={step} onChange={value => updateMode(mode, key, value)} />;
  const tabs = [["normal", "普通流星"], ["shower", "流星雨"], ["other", "其他动效"]] as const;
  return createPortal(<dialog ref={dialog} data-space-settings="true" className="space-settings-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="space-settings-header"><div><div className="eyebrow">ATMOSPHERE CONTROL</div><h2 id={titleId}>星空动效设置</h2></div><button ref={closeButton} type="button" className="secondary space-settings-close" aria-label="关闭星空设置" onClick={onClose}>关闭</button></header>
    <p id={descriptionId} className="space-settings-intro">即改即生效，自动记在此浏览器。预览与全站共用一个调度器，不叠加发射。</p>
    {reduced ? <p className="notice compact-notice space-settings-state" role="status">系统已启用减少动态效果。设置仍可编辑保存，但动画和预览当前不会播放。</p> : !enabled ? <p className="notice compact-notice space-settings-state" role="status">动态星空已关闭。设置仍可保存；请先关闭面板并开启动态星空再预览。</p> : <p className="space-settings-state muted">播放视频、进入后台或打开业务弹窗时自动停止；输入时隐藏前景并暂停自动流星雨判断。</p>}
    {!storageAvailable && <p className="notice warning compact-notice" role="status">浏览器存储受限，本页设置可用，但无法保证刷新保留或跨标签页同步。</p>}
    <div className="space-settings-tabs" role="tablist" aria-label="星空设置分组">{tabs.map(([key, text], index) => <button key={key} type="button" role="tab" id={`${panelId}-${key}`} aria-selected={tab === key} aria-controls={panelId} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={event => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : delta ? (index + delta + tabs.length) % tabs.length : -1;
      if (next < 0) return; event.preventDefault(); setTab(tabs[next]![0]); (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
    }}>{text}</button>)}</div>
    <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} className="space-settings-body" tabIndex={0}>
      {tab === "other" ? <section className="space-settings-section"><h3>克制的空间反馈</h3>
        <ToggleSetting label="星云慢漂移" checked={settings.other.nebula} onChange={value => updateOther("nebula", value)} note="单层低对比星云，以约 72 秒周期小幅移动。" />
        <ToggleSetting label="导航轨道指示" checked={settings.other.navigation} onChange={value => updateOther("navigation", value)} note="选中标记跟随侧栏菜单，保留键盘焦点。" />
        <ToggleSetting label="任务完成光环" checked={settings.other.completion} onChange={value => updateOther("completion", value)} note="仅为本次会话中新确认成功的任务播放一次，不把字节传完当成完成。" />
        <ToggleSetting label="标题与首屏入场" checked={settings.other.entrance} onChange={value => updateOther("entrance", value)} note="轻量淡入；搜索、翻页与普通刷新不重播。" />
      </section> : <>
        <section className="space-settings-section"><h3>{tab === "normal" ? "日常的星际掠影" : "短暂而丰富的流星雨"}</h3>
          <ToggleSetting label={tab === "normal" ? "普通流星" : "流星雨自动触发"} checked={values.enabled} onChange={value => updateMode(mode, "enabled", value)} />
          {tab === "shower" && <><div className="space-settings-grid">
            <NumberSetting label="自动触发概率" value={settings.shower.probability} min={0} max={100} unit="% / 次机会" onChange={value => updateMode("shower", "probability", value)} />
            <NumberSetting label="持续时间" value={settings.shower.duration} min={1} max={30} unit="秒" step={0.5} onChange={value => updateMode("shower", "duration", value)} />
            <NumberSetting label="两场冷却时间" value={settings.shower.cooldown} min={5} max={600} unit="秒" onChange={value => updateMode("shower", "cooldown", value)} />
          </div><p className="space-settings-note">每次满足条件的普通流星发射机会独立判断一次，非每帧判断。须普通流星开启、冷却结束、页面可见、未播放、无业务弹窗且未输入；0% 不自动触发，100% 也遵守冷却。手动预览只跳过概率与冷却。</p></>}
        </section>
        <section className="space-settings-section"><h3>数量与节奏</h3><p className="space-settings-note">每批数量、同屏总量、两批开始的间隔分别控制。前景与背景合计不超过同屏上限。</p><div className="space-settings-grid">
          {number("batchMin", "每批最少数量", 1, 24, "条")}{number("batchMax", "每批最多数量", 1, 24, "条")}
          {number("maxVisible", "同屏最大数量", 1, 48, "条 / 前后景合计")}
          {number("intervalMin", "最短发射间隔", 0.1, 60, "秒", 0.01)}{number("intervalMax", "最长发射间隔", 0.1, 60, "秒", 0.01)}
        </div></section>
        <section className="space-settings-section"><h3>体量、速度与光色</h3><div className="space-settings-grid">
          {number("sizeMin", "最小尺寸倍率", 0.2, 4, "倍", 0.1)}{number("sizeMax", "最大尺寸倍率", 0.2, 4, "倍", 0.1)}
          {number("durationMin", "最短飞行时长", 0.5, 8, "秒", 0.1)}{number("durationMax", "最长飞行时长", 0.5, 8, "秒", 0.1)}
          {number("tailScale", "拖尾长度倍率", 0.3, 3, "倍", 0.1)}{number("glow", "发光强度", 0, 2, "倍", 0.1)}
        </div><p className="space-settings-note">每条流星独立生成位置、尺寸、飞行时长和颜色；修改尺寸不会改变飞行路径。范围反向时会自动排序，空值与无效值不保存。</p>
          <fieldset className="space-color-field"><legend>流星色板（至少保留一种）</legend><div className="space-color-options">{Object.entries(colorLabels).map(([key, text]) => <label key={key}><input type="checkbox" checked={values.colors.includes(key as keyof typeof colorLabels)} onChange={event => { const next = event.target.checked ? [...values.colors, key as keyof typeof colorLabels] : values.colors.filter(color => color !== key); if (next.length) updateMode(mode, "colors", next); }} /><span className={`space-color-swatch space-color-${key}`} aria-hidden="true" />{text}</label>)}</div></fieldset>
          <ToggleSetting label="双色渐变拖尾" checked={values.dualColor} onChange={value => updateMode(mode, "dualColor", value)} note="从所选色板搭配星核与拖尾颜色。" />
        </section>
        <section className="space-settings-section"><h3>前景层次</h3><ToggleSetting label="前景流星" checked={values.foreground} onChange={value => updateMode(mode, "foreground", value)} note="可以划过卡片，但不拦截点击，也不盖过导航与业务弹窗。手机强制关闭。" />
          {number("foregroundRatio", "前景比例", 0, 100, "%")}
        </section>
      </>}
      <section className="space-device-limits" aria-label="设备实际生效设置"><h3>{device.kind === "mobile" ? "手机节能模式" : device.kind === "constrained" ? "低功耗设备模式" : "桌面模式"} · 实际生效</h3><p>设备硬上限 {device.hardLimit} 条；普通同屏 ≤ {effective.normal.maxVisible} 条，流星雨 ≤ {effective.shower.maxVisible} 条。{device.foreground ? "前景遵守各自开关与比例。" : "当前设备前景强制关闭。"}</p><p>普通每批 {effective.normal.batchMin}～{effective.normal.batchMax} 条，间隔 {effective.normal.intervalMin}～{effective.normal.intervalMax} 秒，尺寸 {effective.normal.sizeMin}～{effective.normal.sizeMax} 倍；流星雨每批 {effective.shower.batchMin}～{effective.shower.batchMax} 条，间隔 {effective.shower.intervalMin}～{effective.shower.intervalMax} 秒，尺寸 {effective.shower.sizeMin}～{effective.shower.sizeMax} 倍。</p><small>设备限制只降低实际效果，不覆盖你保存的偏好。</small></section>
    </div>
    <footer className="space-settings-footer"><div className="space-preview-actions"><button type="button" className="secondary" disabled={!enabled} onClick={() => preview("normal")}>预览普通流星</button><button type="button" disabled={!enabled} onClick={() => preview("shower")}>立即预览流星雨</button><button type="button" className="secondary" disabled={!previewMode} onClick={stopPreview}>停止预览</button></div><div className="space-settings-footer-meta"><span role="status">{previewMode === "shower" ? "流星雨预览中 · 自然退场后恢复普通模式" : previewMode === "normal" ? "普通流星预览中" : "预览仍遵守播放、后台、输入与设备限制"}</span><button type="button" className="space-reset-button" onClick={resetSettings}>恢复默认值</button></div></footer>
  </dialog>, document.body);
}
