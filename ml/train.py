#!/usr/bin/env python3
"""
Trains a real scikit-learn RandomForestRegressor on the harvestRecords
logged through the app (Farmer -> Crop Growth Logs -> log a Harvest entry).

This is the actual "feed it data" step: every harvest record captures the
soil parameters and recent climate conditions at that farm, paired with the
real yield the farmer reported. That table (db.json -> harvestRecords) *is*
the training set / database for the model — there was nothing wrong with
using a JSON file as the store, the earlier version was just missing (a)
a place to record ground-truth outcomes and (b) a training pipeline that
reads them. This script is that pipeline.

Usage:
    python train.py
Requires:
    pip install -r requirements.txt
Writes:
    model.joblib   -- the trained model + feature schema
    metrics.json   -- honest, cross-validated performance numbers
Prints the metrics JSON to stdout as the last line (server.js parses it).
"""
import json
import os
import sys
from datetime import date

try:
    import pandas as pd
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.model_selection import KFold, cross_val_predict
    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
    import joblib
except ImportError as e:
    print(json.dumps({"error": f"Missing Python package: {e.name}. Run: pip install -r ml/requirements.txt"}))
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "..", "server", "db.json")
MODEL_PATH = os.path.join(HERE, "model.joblib")
METRICS_PATH = os.path.join(HERE, "metrics.json")

MIN_RECORDS = 5
NUMERIC_FEATURES = ["nitrogen", "phosphorus", "potassium", "ph", "moisturePercent", "avgTemp", "weeklyRainMm"]


def main():
    with open(DB_PATH, "r") as f:
        db = json.load(f)
    records = db.get("harvestRecords", [])

    if len(records) < MIN_RECORDS:
        print(json.dumps({
            "error": f"Not enough training data. Need at least {MIN_RECORDS} harvest records, have {len(records)}. "
                     f"Log more harvest outcomes from the farmer dashboard, then train again."
        }))
        sys.exit(1)

    df = pd.DataFrame(records)

    for col in NUMERIC_FEATURES:
        if col not in df:
            df[col] = None
        df[col] = pd.to_numeric(df[col], errors="coerce")
        df[col] = df[col].fillna(df[col].median())

    crop_categories = sorted(df["cropType"].dropna().unique().tolist())
    crop_dummies = pd.get_dummies(df["cropType"], prefix="crop")
    for cat in crop_categories:
        col = f"crop_{cat}"
        if col not in crop_dummies.columns:
            crop_dummies[col] = 0

    X = pd.concat([df[NUMERIC_FEATURES], crop_dummies], axis=1)
    y = pd.to_numeric(df["actualYieldTonPerHa"], errors="coerce")

    n = len(df)
    n_splits = min(5, n)
    model = RandomForestRegressor(n_estimators=200, random_state=42)

    rmse = mae = r2 = None
    if n_splits >= 2:
        kf = KFold(n_splits=n_splits, shuffle=True, random_state=42)
        preds = cross_val_predict(model, X, y, cv=kf)
        rmse = mean_squared_error(y, preds) ** 0.5
        mae = mean_absolute_error(y, preds)
        r2 = r2_score(y, preds)

    # Refit on all available data for the model we actually save/serve.
    model.fit(X, y)
    joblib.dump(
        {"model": model, "feature_columns": list(X.columns), "crop_categories": crop_categories},
        MODEL_PATH,
    )

    metrics = {
        "yieldModel": {
            "type": "Random Forest Regressor (scikit-learn)",
            "rmse": round(rmse, 3) if rmse is not None else None,
            "mae": round(mae, 3) if mae is not None else None,
            "r2": round(r2, 3) if r2 is not None else None,
            "lastTrained": date.today().isoformat(),
            "crossValidationFolds": n_splits if n_splits >= 2 else None,
        },
        "trainingSamples": n,
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)

    print(json.dumps(metrics))


if __name__ == "__main__":
    main()
