from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class VehicleRecord(Base):
    __tablename__ = "vehicles"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)


class TrackElementRecord(Base):
    __tablename__ = "track_elements"
    __table_args__ = (
        CheckConstraint(
            "element_type IN ('YARD', 'PLATFORM', 'BLOCK')",
            name="ck_track_elements_type",
        ),
        CheckConstraint(
            "traversal_seconds IS NULL OR traversal_seconds >= 0",
            name="ck_track_elements_traversal_non_negative",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    element_type: Mapped[str] = mapped_column(String(16))
    traversal_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    interlocking_group: Mapped[str | None] = mapped_column(String(32), nullable=True)


class TrackConnectionRecord(Base):
    __tablename__ = "track_connections"

    from_element_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("track_elements.id", ondelete="RESTRICT"),
        primary_key=True,
    )
    to_element_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("track_elements.id", ondelete="RESTRICT"),
        primary_key=True,
    )


class ServiceRecord(Base):
    __tablename__ = "services"
    __table_args__ = (
        Index("ix_services_vehicle_start_time", "vehicle_id", "start_time"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    vehicle_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("vehicles.id", ondelete="RESTRICT"),
    )
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    path_elements: Mapped[list["ServicePathElementRecord"]] = relationship(
        back_populates="service",
        cascade="all, delete-orphan",
        order_by="ServicePathElementRecord.path_index",
        passive_deletes=True,
    )


class ServicePathElementRecord(Base):
    __tablename__ = "service_path_elements"
    __table_args__ = (
        CheckConstraint(
            "path_index >= 0",
            name="ck_service_path_elements_index_non_negative",
        ),
        CheckConstraint(
            "interval_end_time >= interval_start_time",
            name="ck_service_path_elements_interval_order",
        ),
    )

    service_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("services.id", ondelete="CASCADE"),
        primary_key=True,
    )
    path_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    element_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("track_elements.id", ondelete="RESTRICT"),
    )
    interval_start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    interval_end_time: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    service: Mapped[ServiceRecord] = relationship(back_populates="path_elements")
