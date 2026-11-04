import { useCallback, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useSpaceMotion } from "../space-motion";
import { useSpaceMeteors } from "../space-meteors";
import type { LibraryEncouragementMessage } from "./library-feed";
import { createBlessingBurst } from "./library-blessing";
import type { BlessingBurst } from "./library-blessing";
import { LibraryBlessingEffect } from "./library-blessing-effect";

const cosmosStars = [[12, 26], [37, 83], [62, 15], [83, 58], [109, 32], [131, 12], [158, 45], [182, 22], [211, 48], [254, 19], [289, 40], [308, 16], [22, 137], [55, 160], [91, 117], [122, 151], [153, 101], [178, 158], [202, 137], [263, 155], [292, 117], [310, 164]] as const;

function EncouragementCosmos() {
  const id = useId();
  return <svg className="library-encouragement-cosmos" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id={`${id}-sky`} cx="65%" cy="35%" r="95%"><stop stopColor="#153b52" /><stop offset=".5" stopColor="#071a2e" /><stop offset="1" stopColor="#020914" /></radialGradient>
      <radialGradient id={`${id}-nebula`}><stop stopColor="#4388af" stopOpacity=".4" /><stop offset="1" stopColor="#4388af" stopOpacity="0" /></radialGradient>
      <radialGradient id={`${id}-halo`}><stop stopColor="#83e4e7" stopOpacity=".25" /><stop offset="1" stopColor="#83e4e7" stopOpacity="0" /></radialGradient>
      <radialGradient id={`${id}-planet`} cx="28%" cy="22%" r="85%"><stop stopColor="#bdebf0" /><stop offset=".35" stopColor="#579db5" /><stop offset=".7" stopColor="#245574" /><stop offset="1" stopColor="#0b2037" /></radialGradient>
      <linearGradient id={`${id}-meteor`} x1="-28" y1="-14" x2="0" y2="0" gradientUnits="userSpaceOnUse"><stop stopColor="#c8f7ff" stopOpacity="0" /><stop offset="1" stopColor="#e8fcff" /></linearGradient>
    </defs>
    <path d="M0 0h320v180H0Z" fill={`url(#${id}-sky)`} />
    <g className="library-cosmos-nebula">
      <ellipse cx="123" cy="88" rx="150" ry="66" transform="rotate(-24 123 88)" fill={`url(#${id}-nebula)`} />
      <ellipse cx="244" cy="122" rx="103" ry="73" fill={`url(#${id}-halo)`} />
    </g>
    <g className="library-cosmos-stars" fill="#d8f2ff">
      {cosmosStars.map(([cx, cy], index) => <circle key={index} className="library-cosmos-star" cx={cx} cy={cy} r={index % 5 === 0 ? 1.4 : .8} opacity={.4 + index % 4 * .15} style={{ "--star-duration": `${3.8 + index % 4 * .8}s`, "--star-delay": `${-index % 6 * .7}s` } as CSSProperties} />)}
      <path d="m54 42 29-17 27 27 33-18" stroke="#acd7ed" strokeWidth=".8" opacity=".18" />
      <path className="library-cosmos-star" d="M54 38v8m-4-4h8M278 62v6m-3-3h6" stroke="#d7f6ff" strokeWidth="1" />
    </g>
    <circle cx="232" cy="108" r="65" fill={`url(#${id}-halo)`} />
    <g className="library-cosmos-orbit">
      <ellipse cx="232" cy="108" rx="59" ry="17" transform="rotate(-24 232 108)" stroke="#91d8e7" strokeWidth="1" opacity=".45" />
      <circle cx="286" cy="84" r="2.4" fill="#d9fbff" />
      <circle cx="286" cy="84" r="6" stroke="#b3f0ff" opacity=".2" />
    </g>
    <g className="library-cosmos-planet">
      <circle cx="232" cy="108" r="32" fill={`url(#${id}-planet)`} />
      <path d="M208 98c12-9 30-10 43-3m-47 11c15-7 34-5 48 1m-42 8c11-4 25-1 35 4" stroke="#c5eef0" strokeWidth="1.5" opacity=".18" />
      <path d="M179 130c17 7 54-5 93-29" stroke="#b3e8ee" strokeWidth="1.2" opacity=".55" />
    </g>
    <g className="library-cosmos-meteor">
      <path d="m-28-14 28 14" stroke={`url(#${id}-meteor)`} strokeWidth="1.4" strokeLinecap="round" />
      <circle r="1.4" fill="#e8fcff" />
    </g>
  </svg>;
}

function messageStyle(index: number): CSSProperties {
  return { "--encouragement-delay": `${index === 0 ? 0 : (index - 3) * 6}s` } as CSSProperties;
}

export function LibraryEncouragement({ messages }: { messages: readonly LibraryEncouragementMessage[] }) {
  const { enabled } = useSpaceMotion();
  const { device } = useSpaceMeteors();
  const [paused, setPaused] = useState(false);
  const [burst, setBurst] = useState<{ id: number; data: BlessingBurst } | null>(null);
  const activity = useRef({ active: false, id: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const finish = useCallback(() => {
    if (!activity.current.active) return;
    activity.current.active = false;
    setBurst(null);
    if (document.visibilityState !== "hidden" && (document.activeElement === document.body || document.activeElement?.closest(".library-blessing-effect"))) trigger.current?.focus({ preventScroll: true });
  }, []);
  const celebrate = () => {
    if (activity.current.active || document.visibilityState === "hidden") return;
    activity.current.active = true;
    setBurst({ id: ++activity.current.id, data: createBlessingBurst(device, window.innerWidth, window.innerHeight, enabled) });
  };
  return <aside className="library-encouragement library-grid-entry" aria-label="戳一戳，有惊喜" data-paused={paused} data-celebrating={!!burst}>
    <EncouragementCosmos />
    <button ref={trigger} type="button" className="library-encouragement-trigger" aria-label="点亮祝福彩蛋" aria-disabled={!!burst} aria-busy={!!burst} title={burst ? "祝福送达中" : "点击接住一场流星雨"} onClick={celebrate} />
    <div className="library-encouragement-header">
      <span>戳一戳，有惊喜</span>
      <button hidden type="button" className="library-encouragement-pause" disabled={!enabled} aria-label={paused ? "继续播放寄语" : "暂停寄语"} title={enabled ? paused ? "继续播放寄语" : "暂停寄语" : "动态效果已关闭，当前静态展示"} onClick={() => setPaused(value => !value)}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">{paused ? <path d="m7 4 9 6-9 6Z" fill="currentColor" /> : <path d="M7 5v10M13 5v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}</svg>
      </button>
    </div>
    <div className="library-encouragement-stage" aria-hidden="true">
      {messages.map((message, index) => <div key={message.id} className={`library-encouragement-message library-encouragement-${message.kind}`} style={messageStyle(index)} data-message-id={message.id}>
        <p>{message.text}</p>
      </div>)}
    </div>
    <div className="library-encouragement-dots" aria-hidden="true">{messages.map((message, index) => <span key={message.id} style={messageStyle(index)} />)}</div>
    <span className="library-encouragement-hint" aria-hidden="true">{burst ? "祝福送达中" : "点亮好运"}</span>
    <ul className="library-encouragement-accessible">{messages.map(message => <li key={message.id}>{message.text}</li>)}</ul>
    {burst && <LibraryBlessingEffect key={burst.id} burst={burst.data} enabled={enabled} onFinish={finish} />}
  </aside>;
}
