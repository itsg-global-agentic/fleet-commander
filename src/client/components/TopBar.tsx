export function TopBar() {
  return (
    <header className="h-12 min-h-[48px] bg-dark-surface border-b border-dark-border flex items-center px-4">
      <h1 className="text-sm font-semibold text-dark-text tracking-wide">
        Fleet Commander
      </h1>
      {/* Placeholder for summary pills (T13) */}
      <div className="flex-1" />
    </header>
  );
}
