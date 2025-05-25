export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-background to-sky-100 dark:from-slate-900 dark:to-sky-950 p-4">
      {children}
    </div>
  );
}
