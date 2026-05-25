export interface HighlightBadgeProps {
  reason: string;        // shown on hover tooltip
  className?: string;    // optional additional styling
  onClick?: () => void;  // optional click handler
}

/**
 * HighlightBadge — small star icon overlaid on photo thumbnails to mark
 * AI-selected highlights. The reason text is shown on hover via the
 * native HTML `title` tooltip.
 *
 * The badge is positioned absolutely in the top-right corner of its
 * parent. The parent must have `position: relative` (or similar) for
 * the badge to anchor correctly.
 */
export default function HighlightBadge({ reason, className, onClick }: HighlightBadgeProps) {
  const isInteractive = typeof onClick === 'function';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <div
      role={isInteractive ? 'button' : 'img'}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={`精华照片：${reason}`}
      title={reason}
      data-testid="highlight-badge"
      className={className}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      style={{
        position: 'absolute',
        top: 6,
        right: 6,
        width: 24,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        background: 'rgba(255, 193, 7, 0.95)',
        border: '1.5px solid #fff',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
        color: '#fff',
        fontSize: 14,
        lineHeight: 1,
        cursor: isInteractive ? 'pointer' : 'default',
        userSelect: 'none',
        zIndex: 2,
      }}
    >
      <span aria-hidden="true">★</span>
    </div>
  );
}
