"""Server-side XP awards for online matches (same formula as src/progression/progression.js).

The server computes each player's award from the authoritative result, so a client cannot
claim XP for tags or wins it did not earn in an online match.
"""
import math


def compute_xp(result, player_id, cfg):
    row = next((r for r in result["ranking"] if r["id"] == player_id), None)
    if not row:
        return {"total": 0, "parts": []}
    parts = [["Participation", cfg["xpParticipation"]]]
    if row["tags"]:
        parts.append([f"Tags ×{row['tags']}", row["tags"] * cfg["xpPerTag"]])
    surv = math.floor(row["survival"] * cfg["xpPerSurvivalSecond"])
    if surv > 0:
        parts.append(["Survival", surv])
    if row["winner"]:
        parts.append(["Victory", cfg["xpWin"]])
    elif row["place"] <= 3 and len(result["ranking"]) >= 4:
        parts.append(["Top 3", cfg["xpTop3"]])
    return {"total": sum(v for _, v in parts), "parts": parts}
