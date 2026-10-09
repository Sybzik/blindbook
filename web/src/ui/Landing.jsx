// Landing: a rendered-looking key frame standing in for the real 3D scene (built later in code).
// A dark hazy room, one hanging cone lamp, the Blind Booth with a heavy velvet curtain, a CRT glowing inside.
// Smooth gradients, blur and soft light are allowed HERE ONLY. The UI lives inside the scene:
// tally board above the booth, the curtain (main action), a brass plaque, two paper notices.
import React from 'react';
import { Logo, Wordmark, MixnetLamp, SplitFlap } from '../ds';
import { SoundToggle } from './SoundToggle';
const LD_W = 1440, LD_H = 900;

function ldFolds() {
  const widths = [8, 9, 10, 11, 12, 14, 16, 18, 21, 27];
  const total = widths.reduce((a, b) => a + b, 0);
  const stops = [], crests = [];
  let x = 0;
  widths.forEach((w, i) => {
    const t = i / (widths.length - 1);
    const c = i >= widths.length - 2 ? 'rgb(26,40,33)' : `rgb(${Math.round(13 + t * 11)},${Math.round(16 + t * 14)},${Math.round(15 + t * 12)})`;
    stops.push([x / total, '#010202'], [(x + w * 0.45) / total, c], [(x + w * 0.7) / total, '#090c0b'], [(x + w) / total, '#010202']);
    crests.push(594 + x + w * 0.45);
    x += w;
  });
  return { stops, crests, total };
}

function LdCrt({ x, y, w, h, top, price, color, id }) {
  return (
    <g>
      <rect x={x - 30} y={y - 30} width={w + 60} height={h + 60} rx="40" fill={color} opacity=".10" filter="url(#ld-b30)" />
      <rect x={x} y={y} width={w} height={h} rx="12" fill="url(#ld-crtbody)" />
      <rect x={x} y={y} width={w} height={h} rx="12" fill="none" stroke="rgba(220,255,235,.07)" />
      <rect x={x + 9} y={y + 9} width={w - 18} height={h - 26} rx="9" fill="url(#ld-dark-screen)" />
      <text x={x + w / 2} y={y + 28} textAnchor="middle" fill="#6FA886" fontSize="11" style={{ fontFamily: 'var(--font-ui)', letterSpacing: '.08em' }}>{top}</text>
      <text x={x + w / 2} y={y + h - 26} textAnchor="middle" fill={color} fontSize="34" filter="url(#ld-b3)" opacity=".8" style={{ fontFamily: 'var(--font-display)' }}>{price}</text>
      <text x={x + w / 2} y={y + h - 26} textAnchor="middle" fill={color} fontSize="34" style={{ fontFamily: 'var(--font-display)' }}>{price}</text>
      <ellipse cx={x + w * 0.32} cy={y + 18} rx={w * 0.28} ry="7" fill="#fff" opacity=".05" filter="url(#ld-b3)" />
      <circle cx={x + w - 16} cy={y + h - 9} r="2" fill="#3FCB7E" />
      <rect x={x + 9} y={y + h + 8} width={w - 18} height="34" fill={color} opacity=".08" filter="url(#ld-b6)" />
    </g>
  );
}

function LandingScene({ px, rim }) {
  const f = React.useMemo(ldFolds, []);
  return (
    <svg className="ld-svg" viewBox={`0 0 ${LD_W} ${LD_H}`} width={LD_W} height={LD_H} aria-hidden="true">
      <defs>
        {[2, 3, 6, 12, 18, 30, 60].map((s) => <filter key={s} id={'ld-b' + s} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={s} /></filter>)}
        <linearGradient id="ld-wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#040806" /><stop offset="1" stopColor="#020403" /></linearGradient>
        <linearGradient id="ld-floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#080d0a" /><stop offset="1" stopColor="#020302" /></linearGradient>
        <linearGradient id="ld-beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#E9FFF2" stopOpacity=".26" /><stop offset=".45" stopColor="#D4F5E2" stopOpacity=".08" /><stop offset="1" stopColor="#D4F5E2" stopOpacity="0" /></linearGradient>
        <linearGradient id="ld-shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#060807" /><stop offset=".3" stopColor="#2b322e" /><stop offset=".45" stopColor="#141916" /><stop offset="1" stopColor="#050706" /></linearGradient>
        <radialGradient id="ld-bulb"><stop offset="0" stopColor="#FFFFFF" /><stop offset=".5" stopColor="#E8FFF1" stopOpacity=".9" /><stop offset="1" stopColor="#C6FFDD" stopOpacity="0" /></radialGradient>
        <linearGradient id="ld-pillar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#070a09" /><stop offset=".35" stopColor="#131a16" /><stop offset=".8" stopColor="#0b0f0d" /><stop offset="1" stopColor="#050706" /></linearGradient>
        <linearGradient id="ld-pillar-r" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#123222" /><stop offset=".12" stopColor="#0d1511" /><stop offset=".6" stopColor="#0a0e0c" /><stop offset="1" stopColor="#040605" /></linearGradient>
        <linearGradient id="ld-canopy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1d2622" /><stop offset=".25" stopColor="#111814" /><stop offset="1" stopColor="#070a08" /></linearGradient>
        <radialGradient id="ld-inside" cx="790" cy="478" r="230" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#5CFF9D" stopOpacity=".42" /><stop offset=".35" stopColor="#3FCB7E" stopOpacity=".14" /><stop offset="1" stopColor="#3FCB7E" stopOpacity="0" /></radialGradient>
        <radialGradient id="ld-screen" cx=".45" cy=".4" r=".75"><stop offset="0" stopColor="#E6FFF0" /><stop offset=".35" stopColor="#8DFFBC" /><stop offset=".8" stopColor="#3FCB7E" /><stop offset="1" stopColor="#1C6B42" /></radialGradient>
        <radialGradient id="ld-dark-screen" cx=".5" cy=".45" r=".7"><stop offset="0" stopColor="#0E2F1E" /><stop offset="1" stopColor="#03100A" /></radialGradient>
        <linearGradient id="ld-crtbody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#252c28" /><stop offset=".5" stopColor="#141916" /><stop offset="1" stopColor="#090b0a" /></linearGradient>
        <linearGradient id="ld-velvet" gradientUnits="userSpaceOnUse" x1="594" y1="0" x2={594 + f.total} y2="0">{f.stops.map(([o, c], i) => <stop key={i} offset={Math.min(1, o)} stopColor={c} />)}</linearGradient>
        <linearGradient id="ld-velvet-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#000" stopOpacity=".55" /><stop offset=".25" stopColor="#000" stopOpacity="0" /><stop offset=".75" stopColor="#000" stopOpacity=".1" /><stop offset="1" stopColor="#000" stopOpacity=".65" /></linearGradient>
        <linearGradient id="ld-spill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5CFF9D" stopOpacity=".34" /><stop offset=".5" stopColor="#5CFF9D" stopOpacity=".1" /><stop offset="1" stopColor="#5CFF9D" stopOpacity="0" /></linearGradient>
        <linearGradient id="ld-refl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8DFFBC" stopOpacity=".28" /><stop offset="1" stopColor="#8DFFBC" stopOpacity="0" /></linearGradient>
        <linearGradient id="ld-board" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2a322e" /><stop offset=".08" stopColor="#141a17" /><stop offset="1" stopColor="#080b09" /></linearGradient>
        <linearGradient id="ld-cab" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1a211d" /><stop offset=".06" stopColor="#0d1210" /><stop offset="1" stopColor="#050706" /></linearGradient>
        <radialGradient id="ld-vig" cx=".5" cy=".46" r=".75"><stop offset=".5" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".9" /></radialGradient>
      </defs>

      <rect width={LD_W} height="650" fill="url(#ld-wall)" />
      <rect y="650" width={LD_W} height="250" fill="url(#ld-floor)" />
      <ellipse cx="720" cy="380" rx="520" ry="300" fill="#BFE8D0" opacity=".035" filter="url(#ld-b60)" />
      <ellipse cx="300" cy="560" rx="260" ry="140" fill="#5CFF9D" opacity=".035" filter="url(#ld-b60)" />
      <ellipse cx="1110" cy="560" rx="200" ry="120" fill="#5CFF9D" opacity=".03" filter="url(#ld-b60)" />
      <rect y="649" width={LD_W} height="2" fill="#0f1612" filter="url(#ld-b2)" />

      <g className="ld-pool"><ellipse cx="700" cy="724" rx="320" ry="52" fill="#DDF7E8" opacity=".07" filter="url(#ld-b18)" /></g>
      <ellipse cx="720" cy="708" rx="270" ry="18" fill="#000" opacity=".75" filter="url(#ld-b6)" />

      <g className="ld-glow">
        <polygon points="746,690 848,690 1040,900 712,900" fill="url(#ld-spill)" filter="url(#ld-b12)" />
        <ellipse cx="800" cy="712" rx="110" ry="14" fill="#5CFF9D" opacity=".22" filter="url(#ld-b12)" />
        <rect x="742" y="706" width="80" height="80" fill="url(#ld-refl)" filter="url(#ld-b6)" />
      </g>

      <rect x="548" y="150" width="344" height="96" fill="url(#ld-board)" />
      <rect x="548" y="150" width="344" height="96" fill="none" stroke="rgba(220,255,235,.08)" />
      <rect x="556" y="158" width="328" height="80" fill="#020403" />
      <rect x="548" y="150" width="344" height="2" fill="#DDF7E8" opacity=".25" filter="url(#ld-b2)" />
      <rect x="600" y="246" width="6" height="16" fill="#0c100e" /><rect x="834" y="246" width="6" height="16" fill="#0c100e" />

      <rect x="592" y="306" width="256" height="382" fill="#010201" />
      <rect x="592" y="306" width="256" height="382" fill="url(#ld-inside)" className="ld-glow" />
      <rect x="600" y="540" width="248" height="10" fill="#0b100d" />
      <rect x="600" y="540" width="248" height="1.5" fill="#5CFF9D" opacity=".35" className="ld-glow" />
      <g className="ld-glow">
        <rect x="722" y="430" width="118" height="110" rx="12" fill="url(#ld-crtbody)" />
        <rect x="738" y="446" width="88" height="72" rx="9" fill="#5CFF9D" opacity=".9" filter="url(#ld-b18)" />
        <rect x="738" y="446" width="88" height="72" rx="9" fill="url(#ld-screen)" />
        {[460, 470, 480, 496].map((yy, i) => <rect key={yy} x="750" y={yy} width={[34, 52, 40, 12][i]} height="3" rx="1.5" fill="#0A3A22" opacity=".55" />)}
        <ellipse cx="760" cy="456" rx="20" ry="6" fill="#fff" opacity=".22" filter="url(#ld-b3)" />
      </g>

      <rect x="506" y="304" width="86" height="386" fill="url(#ld-pillar)" />
      <rect x="516" y="318" width="66" height="358" fill="none" stroke="rgba(220,255,235,.035)" />
      <rect x="848" y="304" width="86" height="386" fill="url(#ld-pillar-r)" />
      <rect x="858" y="318" width="66" height="358" fill="none" stroke="rgba(220,255,235,.035)" />
      <rect x="848" y="306" width="2" height="382" fill="#5CFF9D" opacity=".3" filter="url(#ld-b2)" className="ld-glow" />
      <rect x="490" y="262" width="460" height="44" fill="url(#ld-canopy)" />
      <rect x="490" y="262" width="460" height="2" fill="#E9FFF2" opacity=".28" filter="url(#ld-b2)" />
      <rect x="490" y="304" width="460" height="2" fill="#000" opacity=".8" />
      <rect x="498" y="686" width="444" height="16" fill="url(#ld-canopy)" />
      <rect x="742" y="684" width="106" height="3" fill="#5CFF9D" opacity=".45" filter="url(#ld-b2)" className="ld-glow" />

      <rect x="592" y="309" width="256" height="3" fill="#2a2216" />
      {[600, 616, 632, 648, 664, 680, 698, 718, 740].map((rx) => <ellipse key={rx} cx={rx} cy="313" rx="5" ry="3" fill="none" stroke="#5a4a2c" strokeWidth="1.2" opacity=".7" />)}
      <path d={`M594,314 L${594 + f.total},314 C748,420 752,560 740,684 Q728,691 716,685 Q704,692 692,686 Q680,692 668,686 Q656,691 644,686 Q630,691 618,686 Q606,691 594,687 Z`} fill="url(#ld-velvet)" />
      <path d={`M594,314 L${594 + f.total},314 C748,420 752,560 740,684 Q728,691 716,685 Q704,692 692,686 Q680,692 668,686 Q656,691 644,686 Q630,691 618,686 Q606,691 594,687 Z`} fill="url(#ld-velvet-shade)" />
      {f.crests.filter((_, i) => i % 2 === 1 || i > 6).map((cx, i) => <line key={i} x1={cx} y1="340" x2={cx + 1} y2="664" stroke="#C9E8D6" strokeOpacity={0.05 + i * 0.012} strokeWidth="2" filter="url(#ld-b2)" />)}
      <path className="ld-rim-glow" d="M738,316 C748,420 752,560 740,684" fill="none" stroke="#5CFF9D" strokeWidth="10" filter="url(#ld-b12)" opacity={rim ? 0.75 : 0.18} />
      <path className="ld-rim" d="M738,316 C748,420 752,560 740,684" fill="none" stroke={rim ? '#C6FFDD' : '#5CFF9D'} strokeWidth="2.5" filter="url(#ld-b2)" opacity={rim ? 1 : 0.5} />

      <g className="ld-beam" style={{ mixBlendMode: 'screen' }}>
        <polygon points="626,126 774,126 1010,710 390,710" fill="url(#ld-beam)" filter="url(#ld-b18)" />
        <polygon points="662,126 738,126 860,710 540,710" fill="url(#ld-beam)" opacity=".6" filter="url(#ld-b12)" />
      </g>
      <line x1="700" y1="0" x2="700" y2="66" stroke="#1b221e" strokeWidth="2" />
      <path d="M688,64 L712,64 L716,76 C752,88 772,106 780,124 L620,124 C628,106 648,88 684,76 Z" fill="url(#ld-shade)" />
      <path d="M716,76 C752,88 772,106 780,124" fill="none" stroke="#E9FFF2" strokeOpacity=".12" strokeWidth="1.5" />
      <g className="ld-beam">
        <ellipse cx="700" cy="125" rx="78" ry="7" fill="url(#ld-bulb)" />
        <ellipse cx="700" cy="128" rx="90" ry="16" fill="#E9FFF2" opacity=".35" filter="url(#ld-b12)" />
      </g>

      <rect x="206" y="598" width="228" height="92" fill="url(#ld-cab)" />
      <rect x="206" y="598" width="228" height="1.5" fill="#5CFF9D" opacity=".18" />
      <ellipse cx="320" cy="694" rx="130" ry="10" fill="#000" opacity=".7" filter="url(#ld-b6)" />
      <LdCrt x={212} y={494} w={110} h={104} top={px.la || 'LEGACY'} price={px.a + '¢'} color="#5CFF9D" />
      <LdCrt x={330} y={522} w={102} h={76} top={px.lb || 'PARIVISION'} price={px.b + '¢'} color="#FFB547" />
      <rect x="1044" y="612" width="124" height="80" fill="url(#ld-cab)" />
      <ellipse cx="1106" cy="696" rx="80" ry="8" fill="#000" opacity=".7" filter="url(#ld-b6)" />
      <LdCrt x={1046} y={508} w={120} h={104} top={px.ly || 'P202 · YES'} price={px.y + '¢'} color="#5CFF9D" />

      <rect width={LD_W} height={LD_H} fill="url(#ld-vig)" />
    </svg>
  );
}

function useCoverScale(ref) {
  const [s, setS] = React.useState(1);
  React.useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const fit = () => setS(Math.max(el.clientWidth / LD_W, el.clientHeight / LD_H));
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return s;
}

export function Landing({ onEnter, block, markets, link, coin, prices }) {
  const root = React.useRef(null);
  const s = useCoverScale(root);
  const [rim, setRim] = React.useState(false);
  const [px, setPx] = React.useState({ a: 45, b: 56, y: 62 });
  React.useEffect(() => {
    const t = setInterval(() => setPx((p) => { const a = Math.max(30, Math.min(70, p.a + (Math.random() < 0.5 ? -1 : 1))); return { a, b: 101 - a, y: Math.max(40, Math.min(80, p.y + (Math.random() < 0.5 ? -1 : 1))) }; }), 2600);
    const k = (e) => { if (e.key === 'Enter' && e.target === document.body) onEnter(); };
    window.addEventListener('keydown', k);
    return () => { clearInterval(t); window.removeEventListener('keydown', k); };
  }, []);
  const curtain = { onMouseEnter: () => setRim(true), onMouseLeave: () => setRim(false), onFocus: () => setRim(true), onBlur: () => setRim(false) };
  return (
    <div className="ld" ref={root}>
      <div className="ld-stage" style={{ transform: `translate(-50%, -50%) scale(${s})` }}>
        <LandingScene px={prices || px} rim={rim} />
        <div className="ld-tally" role="img" aria-label={`${markets} markets live, block ${block}, number of traders redacted`}>
          <div className="ld-tally__cell"><SplitFlap value={String(markets)} size="md" /><span>MARKETS LIVE</span></div>
          <div className="ld-tally__cell"><SplitFlap value={String(block % 100000).padStart(5, '0')} size="md" /><span>{coin} BLOCK</span></div>
          <div className="ld-tally__cell"><span className="bb-flap bb-flap--md">{[0, 1, 2, 3].map((i) => <span key={i} className="bb-flap__tile"><span className="bb-flap__ch ld-redch">█</span></span>)}</span><span>TRADERS</span></div>
        </div>
        <button type="button" className="ld-plaque" onClick={() => onEnter()} {...curtain}><i aria-hidden="true" />STEP INSIDE · ENTER<i aria-hidden="true" /></button>
        <button type="button" className="ld-curtain-hit" aria-label="Step into the booth" onClick={() => onEnter()} {...curtain} />
        <button type="button" className="ld-notice ld-notice--how" onClick={() => onEnter('how')}><i className="ld-pin" aria-hidden="true" /><b>HOW IT WORKS</b><span>four steps</span></button>
        <button type="button" className="ld-notice ld-notice--verify" onClick={() => onEnter('verify')}><i className="ld-pin" aria-hidden="true" /><b>VERIFY</b><span>check the books</span></button>
      </div>
      <div className="ld-grain" aria-hidden="true" />
      <header className="ld-tl">
        <div className="ld-brand"><Logo size={28} /><Wordmark height={14} /></div>
        <p className="bb-label">A PRIVATE PREDICTION MARKET ON ZCASH</p>
      </header>
      <div className="ld-tr"><MixnetLamp state={link === 'off' || link === 'tor' ? link : link === 'linked' ? 'linked' : link === 'down' ? 'down' : 'relinking'} /><span>· BLK {block.toLocaleString('en-US')}</span><SoundToggle /></div>
    </div>
  );
}

