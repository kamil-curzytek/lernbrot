import { DAILY_TARGET_OPTIONS } from '../../types';

/** Words per day: 5 to 50 in steps of 5. */
export function DailyTargetPicker({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div className="segmented target-picker" role="radiogroup" aria-label="Words per day">
      {DAILY_TARGET_OPTIONS.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          className={value === n ? 'selected' : ''}
          disabled={disabled}
          onClick={() => onChange(n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
