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


def compute_coins(result, player_id, c):
    """Coins for one player (same formula as computeCoins in progression.js)."""
    row = next((r for r in result["ranking"] if r["id"] == player_id), None)
    if not row or not c:
        return {"coins": 0, "coinParts": []}
    parts = [["Match", c["perMatch"]]]
    if row["tags"]:
        parts.append([f"Tags ×{row['tags']}", row["tags"] * c["perTag"]])
    surv = math.floor(row["survival"] / 10) * c["per10sSurvived"]
    if surv > 0:
        parts.append(["Survival", surv])
    if row["winner"]:
        parts.append(["Victory", c["win"]])
    if row.get("dodges"):
        parts.append([f"Perfect dodges ×{row['dodges']}", row["dodges"] * c["perPerfectDodge"]])
    if row.get("coins"):
        parts.append([f"Coins grabbed ×{row['coins']}", row["coins"] * c["perPickup"]])
    return {"coins": sum(v for _, v in parts), "coinParts": parts}


def compute_award(result, player_id, cfg):
    return {**compute_xp(result, player_id, cfg["progression"]), **compute_coins(result, player_id, cfg["coins"])}
