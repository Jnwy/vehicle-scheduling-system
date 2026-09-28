from dataclasses import dataclass
from enum import StrEnum


class TrackElementType(StrEnum):
    YARD = "YARD"
    PLATFORM = "PLATFORM"
    BLOCK = "BLOCK"


@dataclass(frozen=True)
class TrackElement:
    id: str
    element_type: TrackElementType
    traversal_seconds: int | None = None
    interlocking_group: str | None = None


@dataclass(frozen=True)
class TrackConnection:
    from_element_id: str
    to_element_id: str


@dataclass(frozen=True)
class RailwayTopology:
    elements: dict[str, TrackElement]
    connections: frozenset[TrackConnection]

    def has_element(self, element_id: str) -> bool:
        return element_id in self.elements

    def has_connection(self, from_element_id: str, to_element_id: str) -> bool:
        return TrackConnection(from_element_id, to_element_id) in self.connections
