#!/usr/bin/env bash
# hook fixture: one stdout line that is not JSON — garbage output. At a
# deciding point this fails closed; at an observation point it is a notice.
IFS= read -r _input || true
printf '%s\n' 'this is not JSON'
