"""Audit block summaries and plot each observed day, without fitting a model."""
import json
from pathlib import Path
from datetime import date
import statistics
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

report = json.loads(Path("docs/evidence/daily-repetition-20261002.json").read_text(encoding="utf-8"))
for result in report["results"]:
    days = result["days"]
    for d in days:
        assert (date.fromisoformat(d["day"]).weekday() + 1) % 7 == d["weekday"]
        assert abs(d["drop"] - (d["blocks"][1] / d["blocks"][0] - 1) * 100) < 1e-10
        assert abs(d["recovery"] - (d["blocks"][3] / d["blocks"][1] - 1) * 100) < 1e-10
    for t in result["all"]["thresholds"]:
        assert t["both"] == sum(d["drop"] < -t["threshold"] and d["recovery"] > t["threshold"] for d in days)
    assert abs(statistics.median(d["drop"] for d in days) - result["all"]["medianDrop"]) < 1e-10

r = next(r for r in report["results"] if r["id"] == "legendary:p10")
fig, axes = plt.subplots(1, 2, figsize=(13, 5), layout="constrained")
labels = [d["day"][5:] for d in r["days"]]
y = list(range(len(labels)))
axes[0].barh([v-.18 for v in y], [d["drop"] for d in r["days"]], height=.35, label="Noon / morning − 1", color="#2563eb")
axes[0].barh([v+.18 for v in y], [d["recovery"] for d in r["days"]], height=.35, label="Next dawn / noon − 1", color="#d97706")
axes[0].set_yticks(y, labels)
axes[0].invert_yaxis()
axes[0].axvline(0, color="black", lw=.6)
axes[0].set_xlabel("Change (%)")
axes[0].set_title("Every eligible game day (06→06)")
axes[0].legend(fontsize=8)
for w in [1, 2, 3, 4, 5, 6, 0]:
    s = r["weekdays"][w]
    axes[1].plot(range(4), s["meanBlocks"], marker="o", label=f"{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][w]} (n={s['n']})")
axes[1].set_xticks(range(4), ["06–12", "12–18", "18–24", "00–06\nnext day"])
axes[1].set_ylabel("Daily morning mean = 100; equal-weight dates")
axes[1].set_title("Weekday × time blocks (descriptive only)")
axes[1].legend(ncol=2, fontsize=9)
for ax in axes:
    ax.grid(alpha=.2)
    ax.set_axisbelow(True)
    ax.spines[["top", "right"]].set_visible(False)
fig.suptitle("Legendary cards P10: repetition is stronger for the drop than the rebound", fontsize=13)
fig.supxlabel("19 eligible dates • ≥4 observations per 6-hour block • No interpolation • Only 1 Thursday • Historical exploration", fontsize=9)
fig.savefig("docs/evidence/daily-repetition-20261002.png", dpi=180)
print("Independent summary arithmetic / weekday checks passed")
