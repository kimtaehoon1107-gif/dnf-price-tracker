"""Plot the frozen 06-to-06 evaluation; no model selection or refitting."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

data = json.loads(Path("data/intraday-study/full-day-results.json").read_text(encoding="utf-8"))
Path("docs/evidence/full-day-20261001.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
models = [("hold", "Hold", "#64748b"), ("trend", "Trend", "#b45309"), ("clock", "+ Time of day", "#2563eb"), ("stock", "+ Listings", "#0891b2")]
fig, axes = plt.subplots(2, 2, figsize=(12, 8), layout="constrained")
for row, result in enumerate(sorted(data["results"], key=lambda r: r["id"] != "legendary:p10")):
    hourly = result["hourly"]
    title = "Legendary cards: P10" if result["id"] == "legendary:p10" else "Legendary Soul Crystal"
    left, right = axes[row]
    left.plot(range(24), [h["curve"]["actual"] for h in hourly], color="#111827", lw=2.5, label="Observed")
    for model, label, color in models:
        left.plot(range(24), [next(m["index"] for m in h["curve"]["models"] if m["model"] == model) for h in hourly], label=label, color=color, linestyle="--")
        right.plot(range(24), [next(m["mape"] for m in h["models"] if m["model"] == model) for h in hourly], label=label, color=color)
    left.set_title(f"{title}: average path\n05:00 anchor = 100; 8–10 observed dates/hour", fontsize=11)
    right.set_title(f"{title}: hourly forecast error", fontsize=11)
    left.set_ylabel("Price index (separate scale per item)")
    right.set_ylabel("MAPE (%) — lower is better")
    for ax in (left, right):
        ax.set_xticks([0, 3, 6, 9, 12, 15, 18, 21, 23], ["06", "09", "12", "15", "18", "21", "00", "03", "05"])
        ax.set_xlabel("Target hour (KST); next day starts at 00")
        ax.grid(alpha=.2)
        ax.spines[["top", "right"]].set_visible(False)
        ax.legend(fontsize=8, ncol=2)
fig.suptitle("06:00 → next-day 06:00 | 24 forecasts fixed at issuance", fontsize=15)
fig.supxlabel("Historical reconstruction • 10 issue dates per target • No Thursday issue dates • Not a prospective validation", fontsize=10)
fig.savefig("docs/evidence/full-day-20261001.png", dpi=180)
