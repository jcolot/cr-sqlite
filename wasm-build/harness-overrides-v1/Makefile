# cr-sqlite override of rhashimoto/wa-sqlite v1.x Makefile.
#
# Based on upstream wa-sqlite 1.1.1's Makefile, with cr-sqlite injected:
#   * CFILES_EXTRA  = cr-sqlite's C (crsqlite.c / changes-vtab.c / ext-data.c)
#   * sqlite3.c -> sqlite3-extra.c (amalgamation + core_init.c, for SQLITE_EXTRA_INIT)
#   * WASQLITE_EXTRA_DEFINES = SQLITE_EXTRA_INIT=core_init + FTS5 + CRSQLITE_WASM ...
#   * the Rust core linked as a static archive (libcrsql_bundle_static.a)
#
# We only build the SYNC target `dist/wa-sqlite.mjs` (no Asyncify): it pairs with the
# synchronous OPFSCoopSyncVFS and avoids the Asyncify per-frame stack bloat that
# overflowed cr-sqlite's reentrant crsql_as_crr on the v0 build.

# dependencies
SQLITE_VERSION = version-3.53.0
SQLITE_TARBALL_URL = https://www.sqlite.org/src/tarball/$(SQLITE_VERSION)/sqlite.tar.gz

EXTENSION_FUNCTIONS = extension-functions.c
EXTENSION_FUNCTIONS_URL = https://www.sqlite.org/contrib/download/extension-functions.c?get=25
EXTENSION_FUNCTIONS_SHA3 = ee39ddf5eaa21e1d0ebcbceeab42822dd0c4f82d8039ce173fd4814807faabfa

# cr-sqlite C sources (compiled from the symlinked core at ./crsql)
CFILES_EXTRA = \
	crsqlite.c \
	changes-vtab.c \
	ext-data.c

# source files (sqlite3.c replaced by sqlite3-extra.c = amalgamation + core_init.c)
CFILES = \
	sqlite3-extra.c \
	extension-functions.c \
	main.c \
	libauthorizer.c \
	libfunction.c \
	libhook.c \
	libprogress.c \
	libvfs.c \
	$(CFILES_EXTRA)

JSFILES = \
	src/libauthorizer.js \
	src/libfunction.js \
	src/libhook.js \
	src/libprogress.js \
	src/libvfs.js

dir.crsql := ./crsql/src

vpath %.c src
vpath %.c deps
vpath %.c deps/$(SQLITE_VERSION)
vpath %.c $(dir.crsql)

EXPORTED_FUNCTIONS = src/exported_functions.json
EXPORTED_RUNTIME_METHODS = src/extra_exported_runtime_methods.json
ASYNCIFY_IMPORTS = src/asyncify_imports.json
JSPI_EXPORTS = src/jspi_exports.json

# intermediate files
OBJ_FILES_DIST = $(patsubst %.c,tmp/obj/dist/%.o,$(CFILES))

# Rust core built as a normal wasm static archive (crate-type=staticlib).
RS_LIB_DIR = ./crsql/rs/bundle_static
RS_WASM_TGT = wasm32-unknown-emscripten
RS_WASM_TGT_DIR = $(RS_LIB_DIR)/target/$(RS_WASM_TGT)
RS_RELEASE_A = $(RS_WASM_TGT_DIR)/release/libcrsql_bundle_static.a

# build options
EMCC ?= emcc

CFLAGS_EXTRA = -I'$(dir.crsql)'

CFLAGS_COMMON = \
	-I'deps/$(SQLITE_VERSION)' \
	-Wno-non-literal-null-conversion \
	-DSQLITE_EXPERIMENTAL_PRAGMA_20251114 \
	$(CFLAGS_EXTRA)
CFLAGS_DIST =  -Oz -flto $(CFLAGS_COMMON)

# ALLOW_MEMORY_GROWTH=0 + fixed heap: modern emscripten (6.x) backs a growable heap with
# a *resizable* ArrayBuffer, and its own JS glue (UTF8ToString -> TextDecoder) as well as
# OPFS read/write reject resizable-backed views. A fixed heap sidesteps that. (Same issue
# and fix as the v0 build — it's a toolchain property, not VFS- or harness-specific.)
EMFLAGS_COMMON = \
	-s ALLOW_MEMORY_GROWTH=0 \
	-s INITIAL_MEMORY=134217728 \
	-s WASM=1 \
	-s INVOKE_RUN \
	-s ENVIRONMENT="web,worker" \
	-s STACK_SIZE=5MB \
	-s WASM_BIGINT=0 \
	$(EMFLAGS_EXTRA)

EMFLAGS_DIST = \
	-Oz \
	-flto \
	$(EMFLAGS_COMMON)

EMFLAGS_INTERFACES = \
	-s EXPORTED_FUNCTIONS=@$(EXPORTED_FUNCTIONS) \
	-s EXPORTED_RUNTIME_METHODS=@$(EXPORTED_RUNTIME_METHODS)

EMFLAGS_LIBRARIES = \
	--js-library src/libadapters.js \
	--post-js src/libauthorizer.js \
	--post-js src/libfunction.js \
	--post-js src/libhook.js \
	--post-js src/libprogress.js \
	--post-js src/libvfs.js

# https://www.sqlite.org/compile.html
# NOTE: no -DSQLITE_OMIT_UTF16 — upstream v1's exported_functions.json exports the
# sqlite3_*16 UTF-16 entry points, so omitting them breaks the link. (vlcn's 0.22
# build paired OMIT_UTF16 with a trimmed export list; upstream does not.)
WASQLITE_EXTRA_DEFINES = \
	-DSQLITE_EXTRA_INIT=core_init \
	-DSQLITE_ENABLE_FTS5 \
	-DSQLITE_ENABLE_BYTECODE_VTAB \
	-DDEFAULT_CACHE_SIZE=8000 \
	-DCRSQLITE_WASM

WASQLITE_DEFINES = \
	-DSQLITE_DEFAULT_MEMSTATUS=0 \
	-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1 \
	-DSQLITE_DQS=0 \
	-DSQLITE_LIKE_DOESNT_MATCH_BLOBS \
	-DSQLITE_MAX_EXPR_DEPTH=0 \
	-DSQLITE_OMIT_AUTOINIT \
	-DSQLITE_OMIT_DECLTYPE \
	-DSQLITE_OMIT_DEPRECATED \
	-DSQLITE_OMIT_LOAD_EXTENSION \
	-DSQLITE_OMIT_SHARED_CACHE \
	-DSQLITE_THREADSAFE=0 \
	-DSQLITE_USE_ALLOCA \
	-DSQLITE_ENABLE_BATCH_ATOMIC_WRITE \
	$(WASQLITE_EXTRA_DEFINES)

# directories
.PHONY: all
all: dist

.PHONY: clean
clean:
	rm -rf dist debug tmp

.PHONY: spotless
spotless:
	rm -rf dist debug tmp deps cache

## cache
cache/$(EXTENSION_FUNCTIONS):
	mkdir -p cache
	curl -LsSf '$(EXTENSION_FUNCTIONS_URL)' -o $@

## deps
deps/$(SQLITE_VERSION)/sqlite3.h deps/$(SQLITE_VERSION)/sqlite3.c:
	mkdir -p cache/$(SQLITE_VERSION)
	curl -LsS $(SQLITE_TARBALL_URL) | tar -xzf - -C cache/$(SQLITE_VERSION)/ --strip-components=1
	mkdir -p deps/$(SQLITE_VERSION)
	(cd deps/$(SQLITE_VERSION); ../../cache/$(SQLITE_VERSION)/configure --enable-all && make sqlite3.c)

deps/$(EXTENSION_FUNCTIONS): cache/$(EXTENSION_FUNCTIONS)
	mkdir -p deps
	openssl dgst -sha3-256 -r cache/$(EXTENSION_FUNCTIONS) | sed -e 's/[[:space:]].*//' > deps/sha3
	echo $(EXTENSION_FUNCTIONS_SHA3) > deps/sha3-expected
	cmp deps/sha3 deps/sha3-expected
	rm -rf deps/sha3 deps/sha3-expected $@
	cp 'cache/$(EXTENSION_FUNCTIONS)' $@

sqlite3.c := deps/$(SQLITE_VERSION)/sqlite3.c
sqlite3.extra.c := deps/$(SQLITE_VERSION)/sqlite3-extra.c

# sqlite3-extra.c = amalgamation + cr-sqlite's core_init.c (for SQLITE_EXTRA_INIT).
$(sqlite3.extra.c): $(sqlite3.c) $(dir.crsql)/core_init.c
	cat $(sqlite3.c) $(dir.crsql)/core_init.c > $@

.PHONY: crsqlite-extra
crsqlite-extra: $(sqlite3.extra.c)

## tmp
.PHONY: clean-tmp
clean-tmp:
	rm -rf tmp

tmp/obj/dist/%.o: %.c
	mkdir -p tmp/obj/dist
	$(EMCC) $(CFLAGS_DIST) $(WASQLITE_DEFINES) $^ -c -o $@

# Build the Rust core as a wasm static archive (no bitcode, no build-std).
$(RS_RELEASE_A): export CRSQLITE_COMMIT_SHA = $(shell cd ..; git rev-parse HEAD)
$(RS_RELEASE_A): FORCE
	cd $(RS_LIB_DIR); \
	cargo build --features static,omit_load_extension --release --target $(RS_WASM_TGT)

FORCE: ;

## dist  — SYNC build only (pairs with OPFSCoopSyncVFS)
.PHONY: dist
dist: dist/wa-sqlite.mjs

dist/wa-sqlite.mjs: $(OBJ_FILES_DIST) $(JSFILES) $(EXPORTED_FUNCTIONS) $(EXPORTED_RUNTIME_METHODS) $(RS_RELEASE_A)
	mkdir -p dist
	$(EMCC) $(EMFLAGS_DIST) \
	  $(EMFLAGS_INTERFACES) \
	  $(EMFLAGS_LIBRARIES) \
	  $(RS_RELEASE_A) \
	  $(OBJ_FILES_DIST) -o $@
