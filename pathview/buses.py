"""Buses: virtual Bus Creator and Bus Selector blocks.

A Bus Creator bundles its input signals into one bus signal, a Bus Selector
picks signals out of a bus by name. Both exist only in the editor. Before code
generation the model is rewritten without them: every picked signal is wired
directly from its source, and a subsystem port carrying a bus becomes one port
index per signal in the bus. Subsystem and Interface have no fixed port count
in pathsim, so only the port indices of connections change.

Mirrors src/lib/bus/expand.ts; tests/fixtures/bus_expansion.json keeps both
implementations in agreement.
"""

from __future__ import annotations

from dataclasses import dataclass, field

BUS_CREATOR = "BusCreator"
BUS_SELECTOR = "BusSelector"
SUBSYSTEM = "Subsystem"
INTERFACE = "Interface"
SEPARATOR = "."

# A signal structure is None for a plain signal, else a list of (name, structure) elements


def is_bus_block(node: dict) -> bool:
    return node.get("type") in (BUS_CREATOR, BUS_SELECTOR)


def selected_signals(node: dict) -> list[str]:
    """Signal paths a Bus Selector picks, one per output."""
    value = (node.get("params") or {}).get("signals")
    return [str(v) for v in value] if isinstance(value, list) else []


def signal_leaves(structure) -> list[str]:
    """Leaf signal paths of a structure; a plain signal has the single empty path."""
    if structure is None:
        return [""]
    leaves = []
    for name, sub in structure:
        for path in signal_leaves(sub):
            leaves.append(f"{name}{SEPARATOR}{path}" if path else name)
    return leaves


def element_at(structure, path: str):
    """Structure of the element at a dotted signal path, and whether it exists."""
    current = structure
    found = False
    for name in path.split(SEPARATOR):
        match = next((sub for element, sub in (current or []) if element == name), _MISSING)
        if match is _MISSING:
            return False, None
        current = match
        found = True
    return found, current


_MISSING = object()


def _contains_bus_blocks(nodes: list[dict]) -> bool:
    return any(
        is_bus_block(n) or (bool(n.get("graph")) and _contains_bus_blocks(n["graph"].get("nodes", [])))
        for n in nodes
    )


@dataclass(eq=False)
class BusLevel:
    """One graph level: the root graph or the graph inside a subsystem."""

    id: int
    node_list: list[dict]
    nodes: dict[str, dict]
    connections: list[dict]
    incoming: dict[str, dict]
    parent: tuple[BusLevel, dict] | None
    children: dict[str, BusLevel] = field(default_factory=dict)


class BusModel:
    """Signal structures of a whole model, following wires through bus blocks and subsystems."""

    def __init__(self, nodes: list[dict], connections: list[dict]):
        self._next_id = 0
        self._memo: dict[str, object] = {}
        self._visiting: set[str] = set()
        self.root = self._build_level(nodes, connections, None)

    def _build_level(self, node_list, connections, parent) -> BusLevel:
        level = BusLevel(
            id=self._next_id,
            node_list=node_list,
            nodes={n["id"]: n for n in node_list},
            connections=connections,
            incoming={f"{c['targetNodeId']}:{c['targetPortIndex']}": c for c in connections},
            parent=parent,
        )
        self._next_id += 1
        for node in node_list:
            graph = node.get("graph")
            if node.get("type") == SUBSYSTEM and graph:
                level.children[node["id"]] = self._build_level(
                    graph.get("nodes", []), graph.get("connections", []), (level, node)
                )
        return level

    def level_at(self, path: list[str]) -> BusLevel | None:
        level = self.root
        for node_id in path:
            level = level.children.get(node_id)
            if level is None:
                return None
        return level

    def _source_port_name(self, level: BusLevel, connection: dict) -> str | None:
        source = level.nodes.get(connection["sourceNodeId"])
        port = connection["sourcePortIndex"]
        if source is not None and source.get("type") == INTERFACE and level.parent:
            ports = level.parent[1].get("inputs", [])
        else:
            ports = (source or {}).get("outputs", [])
        return ports[port].get("name") if port < len(ports) else None

    def _element_names(self, level: BusLevel, creator: dict) -> list[str]:
        """Wire label, else source port name, else the creator's input name; unique."""
        used: set[str] = set()
        names = []
        for i, port in enumerate(creator.get("inputs", [])):
            connection = level.incoming.get(f"{creator['id']}:{i}")
            label = (connection.get("label") or "").strip() if connection else ""
            source_name = self._source_port_name(level, connection) if connection else None
            raw = label or source_name or port.get("name") or f"signal {i}"
            base = "_".join(raw.split(SEPARATOR))
            name = base
            n = 2
            while name in used:
                name = f"{base}_{n}"
                n += 1
            used.add(name)
            names.append(name)
        return names

    def structure_in(self, level: BusLevel, node_id: str, port: int):
        connection = level.incoming.get(f"{node_id}:{port}")
        if connection is None:
            return None
        return self.structure_out(level, connection["sourceNodeId"], connection["sourcePortIndex"])

    def structure_out(self, level: BusLevel, node_id: str, port: int):
        key = f"{level.id}:{node_id}:{port}"
        if key in self._memo:
            return self._memo[key]
        # A wire loop through bus blocks has no defined structure
        if key in self._visiting:
            return None
        self._visiting.add(key)
        structure = self._compute_out(level, node_id, port)
        self._visiting.discard(key)
        self._memo[key] = structure
        return structure

    def _compute_out(self, level: BusLevel, node_id: str, port: int):
        node = level.nodes.get(node_id)
        if node is None:
            return None
        kind = node.get("type")
        if kind == BUS_CREATOR:
            return [
                (name, self.structure_in(level, node_id, i))
                for i, name in enumerate(self._element_names(level, node))
            ]
        if kind == BUS_SELECTOR:
            paths = selected_signals(node)
            if port >= len(paths) or not paths[port]:
                return None
            return element_at(self.structure_in(level, node_id, 0), paths[port])[1]
        if kind == SUBSYSTEM:
            inner = level.children.get(node_id)
            iface = next((n for n in inner.node_list if n.get("type") == INTERFACE), None) if inner else None
            return self.structure_in(inner, iface["id"], port) if iface else None
        if kind == INTERFACE and level.parent:
            outer, subsystem = level.parent
            return self.structure_in(outer, subsystem["id"], port)
        return None


def expand_buses(nodes: list[dict], connections: list[dict]) -> tuple[list[dict], list[dict]]:
    """The model without bus blocks, for code generation.

    Models without bus blocks are returned unchanged. Connections that carry
    several signals are split, with IDs suffixed by the signal index. Wiring
    that cannot be resolved, such as a bus into a plain block or a signal
    missing from a bus, is left out.
    """
    if not _contains_bus_blocks(nodes):
        return nodes, connections
    return _Expansion(BusModel(nodes, connections)).expand()


class _Expansion:
    def __init__(self, model: BusModel):
        self.model = model
        self._offsets: dict[str, list[int]] = {}
        self._resolving: set[str] = set()

    @staticmethod
    def _count(structure) -> int:
        return len(signal_leaves(structure))

    @staticmethod
    def _range(node_id: str, offset: int, length: int) -> list[tuple[str, int] | None]:
        return [(node_id, offset + j) for j in range(length)]

    def _offsets_of(self, level: BusLevel, subsystem: dict, direction: str) -> list[int]:
        key = f"{level.id}:{subsystem['id']}:{direction}"
        if key in self._offsets:
            return self._offsets[key]
        ports = len(subsystem.get("inputs" if direction == "in" else "outputs", []))
        result = []
        total = 0
        for i in range(ports):
            result.append(total)
            if direction == "in":
                total += self._count(self.model.structure_in(level, subsystem["id"], i))
            else:
                total += self._count(self.model.structure_out(level, subsystem["id"], i))
        self._offsets[key] = result
        return result

    def _offset(self, level: BusLevel, subsystem: dict, direction: str, port: int) -> int:
        offsets = self._offsets_of(level, subsystem, direction)
        return offsets[port] if port < len(offsets) else port

    def _resolve_in(self, level: BusLevel, node_id: str, port: int):
        connection = level.incoming.get(f"{node_id}:{port}")
        if connection is None:
            return [None]
        return self._resolve_out(level, connection["sourceNodeId"], connection["sourcePortIndex"])

    def _resolve_out(self, level: BusLevel, node_id: str, port: int):
        """Real source of every signal leaving an output, in leaf order."""
        key = f"{level.id}:{node_id}:{port}"
        if key in self._resolving:
            return [None]
        self._resolving.add(key)
        endpoints = self._compute_resolve_out(level, node_id, port)
        self._resolving.discard(key)
        return endpoints

    def _compute_resolve_out(self, level: BusLevel, node_id: str, port: int):
        model = self.model
        node = level.nodes.get(node_id)
        if node is None:
            return [None]
        kind = node.get("type")
        if kind == BUS_CREATOR:
            return [e for i in range(len(node.get("inputs", []))) for e in self._resolve_in(level, node_id, i)]
        if kind == BUS_SELECTOR:
            paths = selected_signals(node)
            path = paths[port] if port < len(paths) else ""
            everything = self._resolve_in(level, node_id, 0)
            leaves = signal_leaves(model.structure_in(level, node_id, 0))
            picked = []
            if path:
                for i, leaf in enumerate(leaves):
                    if leaf == path or leaf.startswith(path + SEPARATOR):
                        picked.append(everything[i] if i < len(everything) else None)
            return picked or [None]
        if kind == SUBSYSTEM:
            return self._range(
                node_id, self._offset(level, node, "out", port), self._count(model.structure_out(level, node_id, port))
            )
        if kind == INTERFACE:
            if not level.parent:
                return [(node_id, port)]
            outer, subsystem = level.parent
            return self._range(
                node_id,
                self._offset(outer, subsystem, "in", port),
                self._count(model.structure_in(outer, subsystem["id"], port)),
            )
        return [(node_id, port)]

    def _input_slots(self, level: BusLevel, node: dict, port: int):
        """Expanded input slots a connection into a port lands on; bus blocks take none."""
        model = self.model
        kind = node.get("type")
        if kind in (BUS_CREATOR, BUS_SELECTOR):
            return []
        if kind == SUBSYSTEM:
            return self._range(
                node["id"], self._offset(level, node, "in", port), self._count(model.structure_in(level, node["id"], port))
            )
        if kind == INTERFACE and level.parent:
            outer, subsystem = level.parent
            return self._range(
                node["id"],
                self._offset(outer, subsystem, "out", port),
                self._count(model.structure_out(outer, subsystem["id"], port)),
            )
        return [(node["id"], port)]

    def expand(self) -> tuple[list[dict], list[dict]]:
        return self._expand_level(self.model.root)

    def _expand_level(self, level: BusLevel) -> tuple[list[dict], list[dict]]:
        nodes = []
        for node in level.node_list:
            if is_bus_block(node):
                continue
            inner = level.children.get(node["id"])
            if inner is not None and node.get("graph"):
                child_nodes, child_connections = self._expand_level(inner)
                nodes.append({**node, "graph": {**node["graph"], "nodes": child_nodes, "connections": child_connections}})
            else:
                nodes.append(node)

        connections = []
        for connection in level.connections:
            target = level.nodes.get(connection["targetNodeId"])
            if target is None or connection["sourceNodeId"] not in level.nodes:
                connections.append(connection)
                continue
            targets = self._input_slots(level, target, connection["targetPortIndex"])
            if not targets:
                continue
            sources = self._resolve_out(level, connection["sourceNodeId"], connection["sourcePortIndex"])
            if len(sources) != len(targets):
                continue
            for i, (source, slot) in enumerate(zip(sources, targets)):
                if source is None or slot is None:
                    continue
                connections.append({
                    **connection,
                    "id": connection["id"] if len(sources) == 1 else f"{connection['id']}{SEPARATOR}{i}",
                    "sourceNodeId": source[0],
                    "sourcePortIndex": source[1],
                    "targetNodeId": slot[0],
                    "targetPortIndex": slot[1],
                })
        return nodes, connections
