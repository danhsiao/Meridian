"""The engine's verb library.

Hand-written once, shared by every generated agent. Nothing in here knows what a
process is: no process_id parameter, no import from processes/, no assumption
about which transport or which domain is on the other end of a channel.

Generated code under processes/<id>/agent/ is orchestration only -- it walks
compiled.topo_order and calls into these verbs.
"""
