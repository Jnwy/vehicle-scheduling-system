from fastapi import FastAPI

app = FastAPI(title="Vehicle Scheduling System")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
