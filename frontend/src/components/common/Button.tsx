// Улучшатели#5 P1·M — Button primitive cascade fix.
// Shared button used across the app. Centralises focus rings, disabled state,
// spinner behaviour, and theme-aware colour selection so individual call sites
// stop reinventing them. All colours route through the cf-* tokens defined in
// tailwind.config.js + index.css so light/dark themes are honoured automatically.

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import clsx from 'clsx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** When true, shows a spinner, disables the button, and hides any leading icon. */
  loading?: boolean
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  /** Native button type. Defaults to "button" to avoid accidental form submits. */
  type?: 'button' | 'submit' | 'reset'
  /** Stretch to fill its parent container. */
  fullWidth?: boolean
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1.5 text-xs gap-1.5 rounded-md',
  md: 'px-4 py-2 text-sm gap-2 rounded-lg',
  lg: 'px-5 py-2.5 text-base gap-2 rounded-xl',
}

const variantClasses: Record<ButtonVariant, string> = {
  // Primary action (Save, Submit, etc). cf-primary already swaps with theme.
  primary:
    'bg-cf-primary text-white hover:bg-cf-secondary focus-visible:ring-cf-primary shadow-sm',
  // Neutral fill — uses panel/border tokens so light theme reads correctly.
  secondary:
    'bg-cf-panel border border-cf-border text-cf-text hover:bg-cf-hover focus-visible:ring-cf-primary',
  // Transparent — best for icon buttons and tertiary actions.
  ghost:
    'bg-transparent text-cf-text-muted hover:text-cf-text hover:bg-cf-hover focus-visible:ring-cf-primary',
  // Destructive — uses cf-error token (red-500) which has acceptable contrast in both themes.
  danger:
    'bg-cf-error text-white hover:bg-red-600 focus-visible:ring-cf-error shadow-sm',
  // Low-emphasis filled — keeps cf-border surface (good for toolbars).
  subtle:
    'bg-cf-border text-cf-text hover:bg-cf-hover focus-visible:ring-cf-primary',
}

const Spinner = ({ size }: { size: ButtonSize }) => {
  const px = size === 'sm' ? 'w-3.5 h-3.5' : size === 'lg' ? 'w-5 h-5' : 'w-4 h-4'
  return <Loader2 className={clsx(px, 'animate-spin')} aria-hidden="true" />
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leadingIcon,
    trailingIcon,
    fullWidth = false,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref
) {
  const isDisabled = disabled || loading
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center font-medium transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-cf-bg',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        sizeClasses[size],
        variantClasses[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size} /> : leadingIcon}
      {children}
      {!loading && trailingIcon}
    </button>
  )
})

export default Button
