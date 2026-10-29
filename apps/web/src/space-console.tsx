import { useId } from "react";
import type { CSSProperties } from "react";
import { SpaceMeteors } from "./space-meteors";
export { SpaceMeteors } from "./space-meteors";

// 固定种子，避免重渲染和切换偏好时星空位置跳变。
const stars = Array.from({ length: 112 }, (_, index) => {
  const seed = (index + 1) * 2654435761 >>> 0;
  const next = Math.imul(seed, 1597334677) >>> 0;
  return {
    left: `${3 + seed % 9400 / 100}%`, top: `${2 + next % 9600 / 100}%`,
    size: index % 19 === 0 ? "2.5px" : index % 3 === 0 ? "1.6px" : "1px",
    duration: `${6 + index % 7}s`, delay: `${-index % 13}s`
  };
});

export function SpaceBackdrop() {
  return <div className="space-atmosphere" aria-hidden="true">
    <div className="space-nebula space-nebula-blue" /><div className="space-nebula space-nebula-violet" />
    <div className="space-starfield">{stars.map((star, index) => <span key={index} className={`space-star${index % 8 === 0 ? " space-star-twinkle" : ""}${index % 19 === 0 ? " space-star-bright" : ""}`} style={{ left: star.left, top: star.top, "--star-size": star.size, "--star-duration": star.duration, "--star-delay": star.delay } as CSSProperties} />)}</div>
    <svg className="space-star-map" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMin slice" focusable="false">
      <g className="space-map-orbits" fill="none">
        <circle cx="1530" cy="585" r="485" />
        <circle cx="1530" cy="585" r="398" strokeDasharray="3 14" />
        <ellipse cx="1330" cy="585" rx="570" ry="178" transform="rotate(-33 1330 585)" />
        <path d="M1080 130h310m-155-62v124M360 890h300m-265-35v70" />
        <path d="m1102 254 98-94 180 126 88-170" />
      </g>
      <g className="space-map-stars">
        <path d="M1200 150v20m-10-10h20M1345 850v20m-10-10h20M537 472v12m-6-6h12" fill="none" stroke="currentColor" />
      </g>
      <g className="space-map-nodes" fill="none">
        <circle cx="1200" cy="160" r="5" /><circle cx="1380" cy="286" r="4" />
        <circle cx="1102" cy="254" r="3" /><circle cx="1468" cy="116" r="3" />
      </g>
    </svg>
    <OrbitChart />
    <SpaceMeteors layer="background" />
  </div>;
}

export function OrbitalMark() {
  return <svg className="orbital-mark" width="44" height="44" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
    <circle cx="24" cy="24" r="15" />
    <ellipse cx="24" cy="24" rx="23" ry="8" transform="rotate(-36 24 24)" />
    <path d="m21 17 10 7-10 7Z" fill="currentColor" stroke="none" />
    <circle cx="38" cy="12" r="2.5" fill="currentColor" stroke="none" />
  </svg>;
}

export function OrbitChart() {
  const id = useId();
  return <svg className="orbit-chart" viewBox="0 0 560 240" fill="none" stroke="currentColor" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id={`${id}-surface`} cx="38%" cy="0%" r="90%"><stop stopColor="var(--space-planet-lit)" /><stop offset=".38" stopColor="var(--space-planet-mid)" /><stop offset="1" stopColor="var(--space-planet-dark)" stopOpacity="0" /></radialGradient>
      <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--space-planet-rim)" stopOpacity="0" /><stop offset=".42" stopColor="var(--space-planet-rim)" /><stop offset="1" stopColor="var(--space-planet-rim)" stopOpacity="0" /></linearGradient>
      <radialGradient id={`${id}-aura`}><stop stopColor="var(--space-planet-rim)" stopOpacity=".15" /><stop offset="1" stopColor="var(--space-planet-rim)" stopOpacity="0" /></radialGradient>
    </defs>
    <ellipse cx="365" cy="150" rx="195" ry="120" fill={`url(#${id}-aura)`} stroke="none" />
    <g className="orbit-chart-grid" strokeWidth=".7"><path d="M155 54h28m-14-14v28M490 56h24m-12-12v24M211 208h270" /><circle cx="365" cy="242" r="199" strokeDasharray="1 9" /><path d="M365 30v19M365 61v8" /></g>
    <circle className="station-planet" cx="365" cy="242" r="172" fill={`url(#${id}-surface)`} stroke="none" />
    <path d="M193 242a172 172 0 0 1 344 0" stroke={`url(#${id}-rim)`} strokeWidth="1.5" />
    <path d="M188 242a177 177 0 0 1 354 0" stroke={`url(#${id}-rim)`} strokeWidth="5" opacity=".13" />
    <g transform="rotate(-18 365 146)">
      <ellipse className="orbit-chart-ring" cx="365" cy="146" rx="195" ry="50" strokeWidth=".8" />
      <g className="orbit-chart-traveler"><circle r="10" fill="currentColor" fillOpacity=".1" stroke="none" /><circle r="3" fill="currentColor" stroke="none" /><circle r="6" strokeWidth=".6" opacity=".5" /></g>
      <g className="orbit-chart-traveler orbit-chart-traveler-secondary"><circle r="2" fill="currentColor" stroke="none" /></g>
    </g>
    <path className="orbit-chart-grid" d="m226 181-20 20h-56M454 80l20-20h60" />
  </svg>;
}

export function OrbitIllustration() {
  return <svg className="orbit-illustration" width="120" height="96" viewBox="0 0 120 96" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true" focusable="false">
    <circle className="orbit-illustration-guide" cx="60" cy="48" r="34" strokeDasharray="2 5" />
    <ellipse cx="60" cy="48" rx="54" ry="19" transform="rotate(-25 60 48)" />
    <rect className="orbit-illustration-window" x="40" y="31" width="40" height="34" rx="8" />
    <path d="m55 40 14 8-14 8Z" />
    <path className="orbit-illustration-guide" d="M15 19h10m-5-5v10m76 49h10m-5-5v10" />
    <circle cx="98" cy="27" r="3" fill="currentColor" stroke="none" />
    <circle cx="22" cy="67" r="2" fill="currentColor" stroke="none" />
  </svg>;
}

export function SatelliteIllustration() {
  return <svg className="orbit-illustration satellite-illustration" width="160" height="124" viewBox="0 0 160 124" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true" focusable="false">
    <g className="satellite-guides"><circle cx="80" cy="62" r="48" strokeDasharray="1 6" /><path d="M18 23h10m-5-5v10m112 67h10m-5-5v10M40 108h22" /></g>
    <g transform="translate(80 62) rotate(-22)"><ellipse rx="66" ry="23" className="satellite-orbit" /><g className="satellite-beacon"><circle r="7" fill="currentColor" fillOpacity=".1" stroke="none" /><circle r="2.5" fill="currentColor" stroke="none" /></g></g>
    <g className="satellite-craft"><g transform="translate(80 62) rotate(-23)">
      <path d="M-24 0h8m32 0h8" />
      <g className="satellite-panels"><rect x="-55" y="-13" width="31" height="26" rx="3" /><rect x="24" y="-13" width="31" height="26" rx="3" /><path d="M-45-13v26m10-26v26m69-26v26m10-26v26m-99-13h31m48 0h31" /></g>
      <rect className="satellite-body" x="-16" y="-18" width="32" height="36" rx="7" />
      <circle cx="0" cy="0" r="8" className="satellite-lens" /><circle cx="0" cy="0" r="3" fill="currentColor" stroke="none" />
      <path d="M0-18v-10m-7-6q7-7 14 0m-11 3q4-4 8 0M-6 18l-3 6H9l-3-6" />
    </g></g>
  </svg>;
}

export function TransferOrbit({ uploaded, total }: { uploaded: number; total: number }) {
  const progress = total > 0 && Number.isFinite(uploaded) && Number.isFinite(total) ? Math.max(0, Math.min(100, uploaded / total * 100)) : 0;
  return <svg className="transfer-orbit" viewBox="0 0 64 64" aria-hidden="true" focusable="false" data-progress={progress}>
    <circle className="transfer-orbit-track" cx="32" cy="32" r="27" fill="none" strokeWidth="3" />
    <circle className="transfer-orbit-value" cx="32" cy="32" r="27" fill="none" strokeWidth="3" pathLength="100" strokeDasharray={`${progress} 100`} transform="rotate(-90 32 32)" />
    <text x="32" y="36" textAnchor="middle">{Math.floor(progress)}%</text>
  </svg>;
}
