from sqlalchemy.orm import Session

from app.domain.models import TrackElementType
from app.domain.topology import assignment_topology
from app.persistence.database import SessionFactory
from app.persistence.models import (
    TrackConnectionRecord,
    TrackElementRecord,
    VehicleRecord,
)


SEEDED_VEHICLE_IDS = ("V1", "V2")
DEFAULT_BLOCK_TRAVERSAL_SECONDS = 20


def seed_database(session: Session) -> None:
    for vehicle_id in SEEDED_VEHICLE_IDS:
        if session.get(VehicleRecord, vehicle_id) is None:
            session.add(VehicleRecord(id=vehicle_id))

    topology = assignment_topology()
    for element in topology.elements.values():
        traversal_seconds = (
            DEFAULT_BLOCK_TRAVERSAL_SECONDS
            if element.element_type == TrackElementType.BLOCK
            else element.traversal_seconds
        )
        record = session.get(TrackElementRecord, element.id)
        if record is None:
            session.add(
                TrackElementRecord(
                    id=element.id,
                    element_type=element.element_type.value,
                    traversal_seconds=traversal_seconds,
                    interlocking_group=element.interlocking_group,
                )
            )
            continue

        record.element_type = element.element_type.value
        record.interlocking_group = element.interlocking_group
        if element.element_type == TrackElementType.BLOCK and record.traversal_seconds is None:
            record.traversal_seconds = traversal_seconds

    session.flush()

    for connection in topology.connections:
        key = (connection.from_element_id, connection.to_element_id)
        if session.get(TrackConnectionRecord, key) is None:
            session.add(
                TrackConnectionRecord(
                    from_element_id=connection.from_element_id,
                    to_element_id=connection.to_element_id,
                )
            )

    session.flush()


def main() -> None:
    with SessionFactory.begin() as session:
        seed_database(session)


if __name__ == "__main__":
    main()
