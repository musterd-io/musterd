// Eval input. FICTIONAL component written for this eval; it is not musterd code.
export function TeamStatusPanel({ members }: { members: Member[] }) {
  return (
    <section className="bg-gradient-to-br from-purple-600 to-blue-500 p-8">
      <p className="text-xs uppercase tracking-[0.3em] text-white/70">— TEAM · LIVE · NOW</p>
      <h2 className="text-3xl font-bold text-white">Your team, supercharged ✨</h2>
      <div className="grid grid-cols-3 gap-4">
        {members.map((m) => (
          <div key={m.id} className="rounded-2xl bg-white/10 backdrop-blur-xl shadow-lg p-4">
            <span className="text-2xl">🤖</span>
            <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-400" />
            <p className="font-mono text-white">// {m.name}</p>
            <p className="text-white/50 text-xs">{m.status}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
