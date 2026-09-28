from app.domain.models import RailwayTopology, TrackConnection, TrackElement, TrackElementType


def assignment_topology() -> RailwayTopology:
    block_ids = [f"B{number}" for number in range(1, 15)]
    platform_ids = ["P1A", "P1B", "P2A", "P2B", "P3A", "P3B"]

    elements = {
        "Y": TrackElement(id="Y", element_type=TrackElementType.YARD),
        **{
            platform_id: TrackElement(
                id=platform_id,
                element_type=TrackElementType.PLATFORM,
            )
            for platform_id in platform_ids
        },
        **{
            block_id: TrackElement(
                id=block_id,
                element_type=TrackElementType.BLOCK,
                interlocking_group=_interlocking_group_for(block_id),
            )
            for block_id in block_ids
        },
    }

    edges = [
        ("Y", "B1"),
        ("B1", "Y"),
        ("B1", "P1A"),
        ("P1A", "B1"),
        ("Y", "B2"),
        ("B2", "Y"),
        ("B2", "P1B"),
        ("P1B", "B2"),
        ("P1A", "B3"),
        ("B3", "B5"),
        ("B5", "P2A"),
        ("P1B", "B4"),
        ("B4", "B5"),
        ("P2A", "B6"),
        ("B6", "B7"),
        ("B7", "P3A"),
        ("B6", "B8"),
        ("B8", "P3B"),
        ("P3A", "B10"),
        ("B10", "B11"),
        ("B11", "P2B"),
        ("P3B", "B9"),
        ("B9", "B11"),
        ("P2B", "B12"),
        ("B12", "B14"),
        ("B14", "P1B"),
        ("B12", "B13"),
        ("B13", "P1A"),
    ]

    return RailwayTopology(
        elements=elements,
        connections=frozenset(TrackConnection(start, end) for start, end in edges),
    )


def _interlocking_group_for(block_id: str) -> str | None:
    groups = {
        "IG1": {"B1", "B2"},
        "IG2": {"B3", "B4", "B13", "B14"},
        "IG3": {"B7", "B8", "B9", "B10"},
    }

    for group_id, block_ids in groups.items():
        if block_id in block_ids:
            return group_id

    return None
