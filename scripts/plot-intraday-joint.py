"""Render the fixed joint evaluation without recalculating or selecting models."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

data = json.loads(Path("data/intraday-study/joint-forecast-results.json").read_text(encoding="utf-8"))
targets = [("레전더리 P10", "Legendary cards: P10"), ("레전더리 소울 결정", "Legendary Soul Crystal")]
labels = ["Hold", "Trend", "+ Time of day", "+ Listings"]
fig, axes = plt.subplots(1, 2, figsize=(11, 4.7), layout="constrained")
for ax, (name, title) in zip(axes, targets):
    result = next(r for r in data["results"] if r["name"] == name)
    models = result["overall"]["models"][:4]
    bars = ax.bar(labels, [m["mape"] for m in models], color=["#64748b", "#94a3b8", "#2563eb", "#0891b2"], width=.65)
    ax.bar_label(bars, fmt="%.2f", padding=4, fontsize=10)
    ax.set_ylim(0, max(m["mape"] for m in models) * 1.24)
    ax.set_ylabel("MAPE (%) — lower is better")
    ax.set_title(f"{title}\n{result['coverage']['scored']} matched evaluation days", fontsize=12)
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="y", alpha=.2)
    ax.set_axisbelow(True)
fig.suptitle("Morning-to-evening price forecasting | Historical reconstruction", fontsize=14)
fig.supxlabel("Origin: 08:00 KST bar close (09:00) → mean of 18:00–20:00 bars\nExploratory results; limited dates; not a trading-profit test", fontsize=9)
fig.savefig("docs/evidence/intraday-joint-20261001.png", dpi=180)
