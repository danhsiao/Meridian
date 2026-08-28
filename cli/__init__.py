"""The command line. fetch | pull | gen | eval | run.

Every command takes `--process <id>` and operates inside `processes/<id>/`.
There is no default process, because a default is where a general engine starts
believing it has one tenant.
"""
