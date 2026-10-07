import React from 'react';

/* Every bet shows its result up front. */
export function PayoutPreview({ outcome, side = 'a', payout, profit, unit = 'ZEC', size = 'md', className = '' }) {
  const oc = side === 'b' ? 'var(--outcome-b)' : 'var(--outcome-a)';
  return (
    <p className={'bb-payout bb-payout--' + size + ' ' + className}>
      <span className="bb-payout__if">If <span style={{ color: oc }}>{outcome}</span> wins →{size === 'lg' ? <br /> : ' '}you get </span>
      <span className={'bb-payout__amt' + (size === 'lg' ? ' bb-glow' : '')}>{payout} {unit}</span>
      {profit && <span className="bb-payout__profit"> ({profit})</span>}
    </p>
  );
}

/* One line under every BUY key: how the trade works. */
export function TradeConditions({ fill = '~2 s', max, fee = '1%', closes = 'at kick-off', items, className = '' }) {
  const parts = items || [fill && `Fills in ${fill}`, max && `max ${max}`, fee && `fee ${fee}`, closes && `trading closes ${closes}`].filter(Boolean);
  return <p className={'bb-conditions ' + className}>{parts.join(' · ')}</p>;
}

/* Standard amounts keep you in the crowd. */
export function AmountChips({ options = ['0.01', '0.05', '0.1', '0.5'], value, onChange, unit = 'ZEC', label = 'AMOUNT', showLabel = true, hoverIndex, className = '' }) {
  return (
    <div className={'bb-chipset ' + className}>
    {showLabel && <span className="bb-label bb-chipset__label">{label} · {unit}</span>}
    <div className="bb-chips" role="radiogroup" aria-label={label + ' in ' + unit}>
      {options.map((o, i) => {
        const on = String(value) === String(o);
        return (
          <button key={o} type="button" role="radio" aria-checked={on} className={'bb-chip' + (on ? ' is-on' : '') + (hoverIndex === i ? ' is-hover' : '')} onClick={() => onChange && onChange(o)}>
            {o}
          </button>
        );
      })}
    </div>
    </div>
  );
}

/* Amount slider + numeric field. */
export function AmountSlider({ value = 0.01, min = 0, max = 0.5, step = 0.001, onChange, unit = 'ZEC', label = 'Amount', decimals = 3, className = '' }) {
  const v = Number(value) || 0;
  const pct = Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  const id = React.useId ? React.useId() : 'bb-amt';
  return (
    <div className={'bb-slider ' + className}>
      <label className="bb-label" htmlFor={id}>{label}</label>
      <div className="bb-slider__row">
        <input type="range" className="bb-slider__range" min={min} max={max} step={step} value={v} aria-label={label}
          style={{ '--pct': pct + '%' }} onChange={(e) => onChange && onChange(e.target.value)} />
        <span className="bb-slider__field">
          <input id={id} inputMode="decimal" value={typeof value === 'number' ? value.toFixed(decimals) : value} onChange={(e) => onChange && onChange(e.target.value)} />
          <span className="bb-slider__unit">{unit}</span>
        </span>
      </div>
      <div className="bb-slider__ticks" aria-hidden="true"><span>{min}</span><span>{(min + max) / 2}</span><span>{max}</span></div>
    </div>
  );
}
