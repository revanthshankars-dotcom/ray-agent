/** RAY's logo: the black notch with two eyes, next to a bold lowercase "ray". */
export function RayMark({ size = 'md', wordmark = true, className = '' }: { size?: 'sm' | 'md' | 'lg'; wordmark?: boolean; className?: string }) {
  const s = size === 'lg' ? { w: 44, h: 22, eye: [5, 9], gap: 7, text: 'text-2xl' } : size === 'sm' ? { w: 30, h: 15, eye: [3.5, 6.5], gap: 5, text: 'text-base' } : { w: 36, h: 18, eye: [4, 8], gap: 6, text: 'text-xl' };
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span aria-hidden className="inline-flex items-center justify-center bg-[#0a0a0b] dark:ring-1 dark:ring-white/15 rounded-full shrink-0" style={{ width: s.w, height: s.h, gap: s.gap }}>
        <span className="rounded-full bg-white ray-eye" style={{ width: s.eye[0], height: s.eye[1] }} />
        <span className="rounded-full bg-white ray-eye" style={{ width: s.eye[0], height: s.eye[1] }} />
      </span>
      {wordmark && <span className={`${s.text} font-extrabold tracking-[-0.04em] text-[#0a0a0b] dark:text-white leading-none`}>ray</span>}
    </span>
  );
}
