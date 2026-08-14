from sqlalchemy import ForeignKey , String , Text , text , DateTime , func
from sqlalchemy.orm import DeclarativeBase , Mapped , mapped_column , relationship
from sqlalchemy.dialects.postgresql import UUID , JSONB , TIMESTAMP
from sqlalchemy.ext.asyncio import async_sessionmaker , AsyncSession , create_async_engine 

import uuid
from datetime import datetime
from pathlib import Path
from starlette.config import Config

# load DATABASE_URL from the .env sitting next to this file, regardless of CWD
config = Config(str(Path(__file__).resolve().parent / ".env"))
class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    user_id :Mapped[uuid.UUID] = mapped_column(primary_key=True)
    chat_id : Mapped["Chat"] = relationship(back_populates="users")
    user_name : Mapped[str] = mapped_column(String(30) , nullable=False)
    user_email : Mapped[str] = mapped_column(String(30),nullable=False)
    password : Mapped[str] = mapped_column(String(1024) , nullable=False)
    created_at : Mapped[datetime] = mapped_column(DateTime(timezone=True) , server_default=func.now())



class Chat(Base):
    __tablename__= "chats"

    chat_id : Mapped[uuid.UUID] = mapped_column(primary_key=True)
    user_id :Mapped["User"] = relationship(back_populates="chats")
    title : Mapped[str] = mapped_column(default="achat")
    messages : Mapped[dict] = mapped_column(JSONB)
    created_at : Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                  server_default=func.now())
    updated_at : Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                  server_onupdate= func.now())
    


DATABASE_URL = config("DATABASE_URL")
engine = create_async_engine(DATABASE_URL)


