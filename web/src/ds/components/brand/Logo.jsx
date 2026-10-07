import React from 'react';
import { ICONS, bitmapRects } from './PixelIcon.jsx';

/* The mark: a 7x7 pixel eye with a solid black redaction bar across it. */
export function Logo({ size = 28, variant = 'tile', withWordmark = false, title = 'Blindbook', style }) {
  const tile = variant === 'tile';
  const paper = variant === 'paper';
  const eye = tile ? 'var(--void)' : paper ? 'var(--ink)' : 'var(--phosphor)';
  const bg = tile ? 'var(--phosphor)' : 'transparent';
  const mark = (
    <svg width={size} height={size} viewBox="-1 -1 9 9" shapeRendering="crispEdges" role="img" aria-label={title}
      style={{ display: 'block', flex: 'none', background: bg }}>
      <g fill={eye}>{bitmapRects(ICONS.eye)}</g>
      <rect x="-0.5" y="3" width="8" height="1" fill="var(--redact)" />
    </svg>
  );
  if (!withWordmark) return <span style={{ display: 'inline-flex', ...style }}>{mark}</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.4, ...style }}>
      {mark}
      <Wordmark height={size * 0.5} color={paper ? 'var(--ink)' : 'var(--phosphor)'} />
    </span>
  );
}

/* 5x7 pixel face, drawn as rects. Only the glyphs BLINDBOOK needs (+ a few spares). */
const GLYPHS = {
  B: ['####.','#...#','#...#','####.','#...#','#...#','####.'],
  L: ['#....','#....','#....','#....','#....','#....','#####'],
  I: ['.###.','..#..','..#..','..#..','..#..','..#..','.###.'],
  N: ['#...#','##..#','##..#','#.#.#','#..##','#..##','#...#'],
  D: ['###..','#..#.','#...#','#...#','#...#','#..#.','###..'],
  O: ['.###.','#...#','#...#','#...#','#...#','#...#','.###.'],
  K: ['#...#','#..#.','#.#..','##...','#.#..','#..#.','#...#'],
  ' ': ['.....','.....','.....','.....','.....','.....','.....'],
};

export function Wordmark({ text = 'BLINDBOOK', height = 14, color = 'var(--phosphor)', redactI = false, redactColor, title, style, className = '' }) {
  const chars = text.toUpperCase().split('');
  const W = chars.length * 6 - 1;
  const rc = redactColor || (color.includes('ink') ? 'var(--redact)' : 'var(--redact-screen)');
  return (
    <svg className={className} width={height * W / 7} height={height} viewBox={`0 0 ${W} 7`} shapeRendering="crispEdges"
      role="img" aria-label={title || text} style={{ display: 'block', flex: 'none', ...style }}>
      {chars.map((c, i) => {
        if (c === 'I' && redactI) return <rect key={i} x={i * 6} y="2.5" width="5" height="2" fill={rc} />;
        const g = GLYPHS[c] || GLYPHS[' '];
        return <g key={i} fill={color} transform={`translate(${i * 6} 0)`}>{bitmapRects(g, i + ':')}</g>;
      })}
    </svg>
  );
}
