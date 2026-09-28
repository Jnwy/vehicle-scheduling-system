"""Create the initial persistence schema.

Revision ID: 0001
Revises:
Create Date: 2026-09-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "vehicles",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "track_elements",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("element_type", sa.String(length=16), nullable=False),
        sa.Column("traversal_seconds", sa.Integer(), nullable=True),
        sa.Column("interlocking_group", sa.String(length=32), nullable=True),
        sa.CheckConstraint(
            "element_type IN ('YARD', 'PLATFORM', 'BLOCK')",
            name="ck_track_elements_type",
        ),
        sa.CheckConstraint(
            "traversal_seconds IS NULL OR traversal_seconds >= 0",
            name="ck_track_elements_traversal_non_negative",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "track_connections",
        sa.Column("from_element_id", sa.String(length=32), nullable=False),
        sa.Column("to_element_id", sa.String(length=32), nullable=False),
        sa.ForeignKeyConstraint(
            ["from_element_id"],
            ["track_elements.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["to_element_id"],
            ["track_elements.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("from_element_id", "to_element_id"),
    )
    op.create_table(
        "services",
        sa.Column("id", sa.Integer(), sa.Identity(), nullable=False),
        sa.Column("vehicle_id", sa.String(length=32), nullable=False),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["vehicle_id"],
            ["vehicles.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_services_vehicle_start_time",
        "services",
        ["vehicle_id", "start_time"],
    )
    op.create_table(
        "service_path_elements",
        sa.Column("service_id", sa.Integer(), nullable=False),
        sa.Column("path_index", sa.Integer(), nullable=False),
        sa.Column("element_id", sa.String(length=32), nullable=False),
        sa.Column("interval_start_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("interval_end_time", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "path_index >= 0",
            name="ck_service_path_elements_index_non_negative",
        ),
        sa.CheckConstraint(
            "interval_end_time >= interval_start_time",
            name="ck_service_path_elements_interval_order",
        ),
        sa.ForeignKeyConstraint(
            ["element_id"],
            ["track_elements.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["service_id"],
            ["services.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("service_id", "path_index"),
    )


def downgrade() -> None:
    op.drop_table("service_path_elements")
    op.drop_index("ix_services_vehicle_start_time", table_name="services")
    op.drop_table("services")
    op.drop_table("track_connections")
    op.drop_table("track_elements")
    op.drop_table("vehicles")
