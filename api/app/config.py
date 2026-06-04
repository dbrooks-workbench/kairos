from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    google_client_id: str
    google_client_secret: str
    base_url: str
    secret_key: str
    database_path: str = "/app/data/kairos.db"


settings = Settings()
