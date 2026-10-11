#!/usr/bin/env bash
# Uso: ./migrar.sh <base_copia> '<ids sedes: 5,8,12>' [preset] [clave=valor ...] [--confirmar]
#   preset = nombre de politicas/<preset>.vars (default: default). Las claves sueltas pisan al preset.
#   Ejemplo: ./migrar.sh gema_academy_migration_test 5,8,12 por_sede cuenta_mixta=descartar --confirmar
# Por defecto es DRY-RUN (rollback). La base debe ser una COPIA desechable.
# PSQL se puede sobreescribir: PSQL="psql -h localhost -U postgres" ./migrar.sh ...
set -euo pipefail
cd "$(dirname "$0")"
PSQL=${PSQL:-"docker exec -i gema_academy_db psql -U postgres"}
DB=$1; KEEP=$2; shift 2
PRESET=default; ARGS=(); CONF=()
for a in "$@"; do
  case "$a" in
    --confirmar) CONF=(-v confirmar=1) ;;
    *=*) ARGS+=(-v "p_${a%%=*}=${a#*=}") ;;
    *) PRESET=$a ;;
  esac
done
PV=()
while IFS='=' read -r k v; do [[ -z "$k" || "$k" == \#* ]] && continue; PV+=(-v "p_$k=$v"); done < "politicas/$PRESET.vars"
# los -v sueltos van despues del preset, asi que lo pisan
sed -e '/@@POLITICA@@/{r sql/_politica_bloque.sql' -e 'd}' sql/30_migrar_sedes.sql \
 | $PSQL -d "$DB" -v ON_ERROR_STOP=1 -v keep="{$KEEP}" "${PV[@]}" "${ARGS[@]}" "${CONF[@]}"
