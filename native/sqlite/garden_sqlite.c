/* Project-owned synchronous Node-API bridge. SQLite itself is pinned and built
 * from the separately verified official amalgamation; no system SQLite/JNI/CLI.
 * No SQL text, bound value, filename or SQLite diagnostic is returned in errors.
 */
#include <node_api.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <math.h>

#define STATEMENT_CACHE_COUNT 64
#define STATEMENT_CACHE_BYTES (1024 * 1024)
#define STATEMENT_CACHE_SQL_BYTES 16384
#define STATEMENT_CACHE_ENTRY_BYTES 65536
typedef struct garden_statement {
  sqlite3_stmt *statement;
  char *sql;
  size_t length, bytes;
  struct garden_statement *previous, *next;
} garden_statement;
typedef struct {
  sqlite3 *db; int in_call;
  garden_statement *first, *last;
  size_t statement_count, statement_bytes, peak_statement_bytes;
  uint64_t cache_hits, cache_misses, cache_evictions, cache_reprepares;
} garden_db;
static const int64_t MAX_SAFE_INTEGER = INT64_C(9007199254740991);

static void unlink_statement(garden_db *handle, garden_statement *entry) {
  if (entry->previous) entry->previous->next = entry->next; else handle->first = entry->next;
  if (entry->next) entry->next->previous = entry->previous; else handle->last = entry->previous;
  handle->statement_count--; handle->statement_bytes -= entry->bytes;
  entry->previous = entry->next = NULL;
}
static int discard_statement(garden_statement *entry, sqlite3_stmt *statement) {
  int rc = sqlite3_finalize(statement);
  if (entry) { free(entry->sql); free(entry); }
  return rc;
}
static int clear_statements(garden_db *handle) {
  int result = SQLITE_OK;
  while (handle->last) {
    garden_statement *entry = handle->last; unlink_statement(handle, entry);
    int rc = discard_statement(entry, entry->statement);
    if (result == SQLITE_OK && rc != SQLITE_OK) result = rc;
  }
  return result;
}
static int cacheable_statement(const char *sql, size_t length) {
  if (length > STATEMENT_CACHE_SQL_BYTES) return 0;
  while (*sql == ' ' || (*sql >= '\t' && *sql <= '\r')) sql++;
  char verb[9]; size_t n = 0;
  while (n < sizeof(verb) - 1 && ((*sql >= 'a' && *sql <= 'z') || (*sql >= 'A' && *sql <= 'Z'))) {
    verb[n++] = *sql >= 'a' && *sql <= 'z' ? (char)(*sql - 'a' + 'A') : *sql; sql++;
  }
  verb[n] = 0;
  // Never cache PRAGMA/DDL/transaction preparation-time side effects.
  return !strcmp(verb,"SELECT") || !strcmp(verb,"WITH") || !strcmp(verb,"INSERT") ||
    !strcmp(verb,"UPDATE") || !strcmp(verb,"DELETE") || !strcmp(verb,"REPLACE");
}
static int release_statement(garden_db *handle, garden_statement *entry, sqlite3_stmt *statement) {
  if (!entry) return sqlite3_finalize(statement);
  // reset() may report a deferred execution/commit error. Clear all host
  // values even on that path; a cache never retains credentials or row data.
  int rc = sqlite3_reset(statement), cleared = sqlite3_clear_bindings(statement);
  handle->cache_reprepares += (uint64_t)sqlite3_stmt_status(statement, SQLITE_STMTSTATUS_REPREPARE, 1);
  if (rc != SQLITE_OK || cleared != SQLITE_OK) {
    discard_statement(entry, statement); return rc != SQLITE_OK ? rc : cleared;
  }
  int used = sqlite3_stmt_status(statement, SQLITE_STMTSTATUS_MEMUSED, 0);
  entry->bytes = sizeof(*entry) + entry->length + 1 + (used > 0 ? (size_t)used : 0);
  if (entry->bytes > STATEMENT_CACHE_ENTRY_BYTES) return discard_statement(entry, statement);
  while (handle->last && (handle->statement_count >= STATEMENT_CACHE_COUNT ||
      handle->statement_bytes + entry->bytes > STATEMENT_CACHE_BYTES)) {
    garden_statement *old = handle->last; unlink_statement(handle, old);
    rc = discard_statement(old, old->statement); handle->cache_evictions++;
    if (rc != SQLITE_OK) { discard_statement(entry, statement); return rc; }
  }
  entry->previous = NULL; entry->next = handle->first;
  if (handle->first) handle->first->previous = entry; else handle->last = entry;
  handle->first = entry; handle->statement_count++; handle->statement_bytes += entry->bytes;
  if (handle->statement_bytes > handle->peak_statement_bytes) handle->peak_statement_bytes = handle->statement_bytes;
  return SQLITE_OK;
}

static int napi_okay(napi_env env, napi_status status) {
  if (status == napi_ok) return 1;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, "ERR_NATIVE_SQLITE_NAPI", "Native SQLite value handling failed");
  return 0;
}

static napi_value undefined_value(napi_env env) {
  napi_value value;
  return napi_okay(env, napi_get_undefined(env, &value)) ? value : NULL;
}

static napi_value sqlite_failure(napi_env env, sqlite3 *db, int rc) {
  napi_value message, error, code, numeric;
  int extended = db ? sqlite3_extended_errcode(db) : rc;
  // Allocator/binder/finalizer return codes are authoritative. A connection's
  // previous extended error must not disguise an unrelated current failure.
  if (rc > 255 || (extended & 255) != (rc & 255)) extended = rc;
  if (!napi_okay(env, napi_create_string_utf8(env, sqlite3_errstr(rc), NAPI_AUTO_LENGTH, &message)) ||
      !napi_okay(env, napi_create_error(env, NULL, message, &error)) ||
      !napi_okay(env, napi_create_string_utf8(env, "ERR_SQLITE_ERROR", NAPI_AUTO_LENGTH, &code)) ||
      !napi_okay(env, napi_set_named_property(env, error, "code", code)) ||
      !napi_okay(env, napi_create_int32(env, extended, &numeric)) ||
      !napi_okay(env, napi_set_named_property(env, error, "errcode", numeric))) return NULL;
  napi_throw(env, error);
  return NULL;
}

static int string_value(napi_env env, napi_value value, char **out, size_t *length, const char *label) {
  napi_valuetype type;
  *out = NULL;
  if (!napi_okay(env, napi_typeof(env, value, &type))) return 0;
  if (type != napi_string) { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", label); return 0; }
  if (!napi_okay(env, napi_get_value_string_utf8(env, value, NULL, 0, length))) return 0;
  if (*length > INT_MAX - 1) { napi_throw_range_error(env, "ERR_OUT_OF_RANGE", "SQLite text exceeds the supported length"); return 0; }
  *out = malloc(*length + 1);
  if (!*out) { sqlite_failure(env, NULL, SQLITE_NOMEM); return 0; }
  if (!napi_okay(env, napi_get_value_string_utf8(env, value, *out, *length + 1, length))) {
    free(*out); *out = NULL; return 0;
  }
  return 1;
}

static garden_db *database_value(napi_env env, napi_value value) {
  garden_db *handle = NULL;
  if (!napi_okay(env, napi_get_value_external(env, value, (void **)&handle))) return NULL;
  if (!handle || !handle->db) {
    napi_throw_error(env, "ERR_SQLITE_CLOSED", "SQLite database is closed"); return NULL;
  }
  if (handle->in_call) {
    napi_throw_error(env, "ERR_SQLITE_REENTRANT", "SQLite connection is already executing a call"); return NULL;
  }
  return handle;
}

static void finalize_database(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  garden_db *handle = data;
  if (handle) { clear_statements(handle); if (handle->db) sqlite3_close_v2(handle->db); free(handle); }
}

static napi_value open_database(napi_env env, napi_callback_info info) {
  size_t argc = 2, length = 0;
  napi_value args[2], result;
  char *filename = NULL;
  bool read_only = false;
  if (!napi_okay(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL))) return NULL;
  if (argc != 2) { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "SQLite open requires filename and read-only mode"); return NULL; }
  if (!string_value(env, args[0], &filename, &length, "SQLite filename must be text")) return NULL;
  if (!length || memchr(filename, 0, length)) {
    free(filename); napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "SQLite filename or read-only mode is invalid"); return NULL;
  }
  if (!napi_okay(env, napi_get_value_bool(env, args[1], &read_only))) { free(filename); return NULL; }
  garden_db *handle = calloc(1, sizeof(*handle));
  if (!handle) { free(filename); return sqlite_failure(env, NULL, SQLITE_NOMEM); }
  int flags = (read_only ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_FULLMUTEX;
  int rc = sqlite3_open_v2(filename, &handle->db, flags, NULL);
  free(filename);
  if (rc != SQLITE_OK) {
    sqlite_failure(env, handle->db, rc);
    if (handle->db) sqlite3_close_v2(handle->db);
    free(handle); return NULL;
  }
  sqlite3_extended_result_codes(handle->db, 1);
  rc = sqlite3_busy_timeout(handle->db, 5000);
  if (rc == SQLITE_OK) rc = sqlite3_exec(handle->db,
    "PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;", NULL, NULL, NULL);
  if (rc != SQLITE_OK) {
    sqlite_failure(env, handle->db, rc); sqlite3_close_v2(handle->db); free(handle); return NULL;
  }
  if (!napi_okay(env, napi_create_external(env, handle, finalize_database, NULL, &result))) {
    sqlite3_close_v2(handle->db); free(handle); return NULL;
  }
  return result;
}

static napi_value close_database(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  garden_db *handle = NULL;
  if (!napi_okay(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL))) return NULL;
  if (argc != 1) { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "SQLite close requires a database"); return NULL; }
  if (!napi_okay(env, napi_get_value_external(env, args[0], (void **)&handle))) return NULL;
  if (!handle || !handle->db) return undefined_value(env);
  if (handle->in_call) { napi_throw_error(env, "ERR_SQLITE_REENTRANT", "SQLite connection is already executing a call"); return NULL; }
  int rc = clear_statements(handle);
  if (rc != SQLITE_OK) return sqlite_failure(env, handle->db, rc);
  rc = sqlite3_close(handle->db);
  if (rc != SQLITE_OK) return sqlite_failure(env, handle->db, rc);
  handle->db = NULL;
  return undefined_value(env);
}

static napi_value exec_sql(napi_env env, napi_callback_info info) {
  size_t argc = 2, length = 0;
  napi_value args[2];
  char *sql = NULL;
  if (!napi_okay(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL))) return NULL;
  if (argc != 2) { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "SQLite exec requires database and SQL"); return NULL; }
  garden_db *handle = database_value(env, args[0]);
  if (!handle || !string_value(env, args[1], &sql, &length, "SQLite SQL must be text")) return NULL;
  if (memchr(sql, 0, length)) {
    free(sql); napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "SQLite SQL cannot contain a NUL byte"); return NULL;
  }
  handle->in_call = 1;
  int rc = sqlite3_exec(handle->db, sql, NULL, NULL, NULL);
  handle->in_call = 0;
  free(sql);
  return rc == SQLITE_OK ? undefined_value(env) : sqlite_failure(env, handle->db, rc);
}

static int bind_value(napi_env env, sqlite3 *db, sqlite3_stmt *statement, int index, napi_value value) {
  napi_valuetype type;
  if (!napi_okay(env, napi_typeof(env, value, &type))) return 0;
  int rc;
  if (type == napi_null || type == napi_undefined) rc = sqlite3_bind_null(statement, index);
  else if (type == napi_number) {
    double number;
    if (!napi_okay(env, napi_get_value_double(env, value, &number))) return 0;
    if (!isfinite(number)) { napi_throw_range_error(env, "ERR_OUT_OF_RANGE", "SQLite number must be finite"); return 0; }
    if (trunc(number) == number) {
      if (fabs(number) > (double)MAX_SAFE_INTEGER) { napi_throw_range_error(env, "ERR_OUT_OF_RANGE", "SQLite integer exceeds the JavaScript safe range"); return 0; }
      rc = sqlite3_bind_int64(statement, index, (sqlite3_int64)number);
    } else rc = sqlite3_bind_double(statement, index, number);
  } else if (type == napi_bigint) {
    int64_t number; bool lossless;
    if (!napi_okay(env, napi_get_value_bigint_int64(env, value, &number, &lossless))) return 0;
    if (!lossless) { napi_throw_range_error(env, "ERR_OUT_OF_RANGE", "SQLite integer exceeds int64 range"); return 0; }
    rc = sqlite3_bind_int64(statement, index, number);
  } else if (type == napi_string) {
    char *text; size_t length;
    if (!string_value(env, value, &text, &length, "SQLite text binding is invalid")) return 0;
    // SQLite owns this UTF-8 allocation after bind, including bind failure.
    // Avoid a second full copy for large persisted checkpoint strings.
    rc = sqlite3_bind_text64(statement, index, text, (sqlite3_uint64)length, free, SQLITE_UTF8);
  } else if (type == napi_object) {
    bool buffer = false, typed = false, view = false;
    void *bytes = NULL; size_t length = 0;
    if (!napi_okay(env, napi_is_buffer(env, value, &buffer)) ||
        !napi_okay(env, napi_is_typedarray(env, value, &typed)) ||
        !napi_okay(env, napi_is_dataview(env, value, &view))) return 0;
    if (buffer) {
      if (!napi_okay(env, napi_get_buffer_info(env, value, &bytes, &length))) return 0;
    } else if (typed) {
      napi_typedarray_type array_type; napi_value array_buffer; size_t offset;
      if (!napi_okay(env, napi_get_typedarray_info(env, value, &array_type, &length, &bytes, &array_buffer, &offset))) return 0;
      size_t width = 1;
      switch (array_type) {
        case napi_int16_array: case napi_uint16_array: width = 2; break;
        case napi_int32_array: case napi_uint32_array: case napi_float32_array: width = 4; break;
        case napi_float64_array: case napi_bigint64_array: case napi_biguint64_array: width = 8; break;
        default: break;
      }
      if (length > SIZE_MAX / width) { napi_throw_range_error(env, "ERR_OUT_OF_RANGE", "SQLite blob is too large"); return 0; }
      length *= width;
    } else if (view) {
      napi_value array_buffer; size_t offset;
      if (!napi_okay(env, napi_get_dataview_info(env, value, &length, &bytes, &array_buffer, &offset))) return 0;
    } else { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "SQLite binding must be null, number, bigint, text or byte view"); return 0; }
    if (length && !bytes) { napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "SQLite byte view has no accessible storage"); return 0; }
    // A non-NULL zero-length pointer distinguishes an empty blob from SQL NULL.
    rc = sqlite3_bind_blob64(statement, index, length ? bytes : "", (sqlite3_uint64)length, SQLITE_TRANSIENT);
  } else { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "SQLite binding type is unsupported"); return 0; }
  if (rc != SQLITE_OK) { sqlite_failure(env, db, rc); return 0; }
  return 1;
}

static int bind_parameters(napi_env env, sqlite3 *db, sqlite3_stmt *statement, napi_value parameters) {
  int count = sqlite3_bind_parameter_count(statement);
  bool array;
  if (!napi_okay(env, napi_is_array(env, parameters, &array))) return 0;
  if (array) {
    uint32_t length;
    if (!napi_okay(env, napi_get_array_length(env, parameters, &length))) return 0;
    if (length != (uint32_t)count) { napi_throw_range_error(env, "ERR_SQLITE_BIND_COUNT", "SQLite positional binding count does not match"); return 0; }
    for (uint32_t i = 0; i < length; i++) {
      napi_value value;
      if (!napi_okay(env, napi_get_element(env, parameters, i, &value)) || !bind_value(env, db, statement, (int)i + 1, value)) return 0;
    }
    return 1;
  }
  napi_valuetype type;
  if (!napi_okay(env, napi_typeof(env, parameters, &type))) return 0;
  if (type != napi_object) { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "SQLite bindings must be an array or named object"); return 0; }
  napi_value names;
  uint32_t length;
  if (!napi_okay(env, napi_get_all_property_names(env, parameters, napi_key_own_only,
        napi_key_enumerable | napi_key_skip_symbols, napi_key_numbers_to_strings, &names)) ||
      !napi_okay(env, napi_get_array_length(env, names, &length))) return 0;
  unsigned char *bound = calloc((size_t)count + 1, 1);
  if (!bound) { sqlite_failure(env, db, SQLITE_NOMEM); return 0; }
  for (uint32_t i = 0; i < length; i++) {
    napi_value name, value;
    char *text = NULL; size_t text_length;
    if (!napi_okay(env, napi_get_element(env, names, i, &name)) ||
        !string_value(env, name, &text, &text_length, "SQLite parameter name is invalid")) { free(bound); return 0; }
    int index = memchr(text, 0, text_length) ? 0 : sqlite3_bind_parameter_index(statement, text);
    if (!index && text_length && !strchr(":@$?", text[0])) {
      char *qualified = malloc(text_length + 2);
      if (!qualified) { free(text); free(bound); sqlite_failure(env, db, SQLITE_NOMEM); return 0; }
      memcpy(qualified + 1, text, text_length + 1);
      for (const char *prefix = ":@$"; *prefix; prefix++) {
        qualified[0] = *prefix;
        int candidate = sqlite3_bind_parameter_index(statement, qualified);
        if (candidate) {
          if (index && index != candidate) { index = 0; break; }
          index = candidate;
        }
      }
      free(qualified);
    }
    free(text);
    if (index <= 0 || index > count || bound[index]) {
      free(bound); napi_throw_range_error(env, "ERR_SQLITE_BIND_NAME", "SQLite named binding is missing, ambiguous or duplicated"); return 0;
    }
    if (!napi_okay(env, napi_get_property(env, parameters, name, &value)) || !bind_value(env, db, statement, index, value)) { free(bound); return 0; }
    bound[index] = 1;
  }
  for (int i = 1; i <= count; i++) if (!bound[i]) {
    free(bound); napi_throw_range_error(env, "ERR_SQLITE_BIND_COUNT", "SQLite named binding count does not match"); return 0;
  }
  free(bound); return 1;
}

static int column_value(napi_env env, sqlite3 *db, sqlite3_stmt *statement, int column, napi_value *value) {
  int kind = sqlite3_column_type(statement, column);
  switch (kind) {
    case SQLITE_NULL: return napi_okay(env, napi_get_null(env, value));
    case SQLITE_INTEGER: {
      int64_t integer = sqlite3_column_int64(statement, column);
      if (integer > MAX_SAFE_INTEGER || integer < -MAX_SAFE_INTEGER) {
        napi_throw_range_error(env, "ERR_OUT_OF_RANGE", "SQLite result integer exceeds the JavaScript safe range"); return 0;
      }
      return napi_okay(env, napi_create_double(env, (double)integer, value));
    }
    case SQLITE_FLOAT: return napi_okay(env, napi_create_double(env, sqlite3_column_double(statement, column), value));
    case SQLITE_TEXT: {
      const unsigned char *text = sqlite3_column_text(statement, column);
      int length = sqlite3_column_bytes(statement, column);
      if (!text && sqlite3_errcode(db) == SQLITE_NOMEM) { sqlite_failure(env, db, SQLITE_NOMEM); return 0; }
      return napi_okay(env, napi_create_string_utf8(env, text ? (const char *)text : "", (size_t)length, value));
    }
    case SQLITE_BLOB: {
      const void *bytes = sqlite3_column_blob(statement, column);
      int length = sqlite3_column_bytes(statement, column);
      if (!bytes && length) { sqlite_failure(env, db, SQLITE_NOMEM); return 0; }
      return napi_okay(env, napi_create_buffer_copy(env, (size_t)length, bytes ? bytes : "", NULL, value));
    }
    default: napi_throw_error(env, "ERR_SQLITE_RESULT_TYPE", "SQLite result type is unsupported"); return 0;
  }
}

static int row_value(napi_env env, sqlite3 *db, sqlite3_stmt *statement, napi_value *result) {
  if (!napi_okay(env, napi_create_object(env, result))) return 0;
  int count = sqlite3_column_count(statement);
  for (int i = 0; i < count; i++) {
    napi_value value;
    if (!column_value(env, db, statement, i, &value)) return 0;
    napi_property_descriptor field = { .utf8name = sqlite3_column_name(statement, i), .value = value,
      .attributes = napi_writable | napi_enumerable | napi_configurable };
    if (!field.utf8name) { sqlite_failure(env, db, SQLITE_NOMEM); return 0; }
    if (!napi_okay(env, napi_define_properties(env, *result, 1, &field))) return 0;
  }
  return 1;
}

static int only_trailing_trivia(const char *tail) {
  while (*tail) {
    if (*tail == ' ' || (*tail >= '\t' && *tail <= '\r') || *tail == ';') { tail++; continue; }
    if (tail[0] == '-' && tail[1] == '-') {
      tail += 2;
      while (*tail && *tail != '\n') tail++;
      continue;
    }
    if (tail[0] == '/' && tail[1] == '*') {
      tail += 2;
      while (*tail && !(tail[0] == '*' && tail[1] == '/')) tail++;
      if (*tail) tail += 2;
      continue;
    }
    return 0;
  }
  return 1;
}

static napi_value execute_query(napi_env env, garden_db *handle, char *sql, size_t length, napi_value parameters, int32_t mode) {
  napi_value result = NULL;
  sqlite3_stmt *statement = NULL;
  garden_statement *entry = NULL;
  int cacheable = cacheable_statement(sql, length), rc = SQLITE_OK;
  if (cacheable) for (entry = handle->first; entry; entry = entry->next) {
    if (entry->length == length && !memcmp(entry->sql, sql, length)) break;
  }
  if (entry) {
    unlink_statement(handle, entry); statement = entry->statement;
    handle->cache_hits++; free(sql);
  } else {
  if (cacheable) handle->cache_misses++;
  const char *tail;
  rc = sqlite3_prepare_v3(handle->db, sql, (int)length + 1, cacheable ? SQLITE_PREPARE_PERSISTENT : 0, &statement, &tail);
  if (rc != SQLITE_OK) { free(sql); return sqlite_failure(env, handle->db, rc); }
  if (!statement) { free(sql); napi_throw_type_error(env, "ERR_SQLITE_EMPTY_STATEMENT", "SQLite prepared statement is empty"); return NULL; }
  // exec() is the only multi-statement API. Never prepare a second statement:
  // some PRAGMAs have effects at prepare time, before sqlite3_step().
  if (!only_trailing_trivia(tail)) {
    sqlite3_finalize(statement); free(sql);
    napi_throw_type_error(env, "ERR_SQLITE_MULTIPLE_STATEMENTS", "SQLite prepare accepts exactly one statement"); return NULL;
  }
  if (cacheable) entry = calloc(1, sizeof(*entry));
  if (entry) { entry->statement = statement; entry->sql = sql; entry->length = length; }
  else free(sql);
  }
  if (!bind_parameters(env, handle->db, statement, parameters)) { discard_statement(entry, statement); return NULL; }
  if (mode == 2 && !napi_okay(env, napi_create_array(env, &result))) { discard_statement(entry, statement); return NULL; }
  uint32_t row_count = 0;
  while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
    if (mode == 0) continue;
    napi_value row;
    if (!row_value(env, handle->db, statement, &row)) { discard_statement(entry, statement); return NULL; }
    if (mode == 1) { result = row; break; }
    else if (!napi_okay(env, napi_set_element(env, result, row_count, row))) { discard_statement(entry, statement); return NULL; }
    if (row_count == UINT32_MAX) {
      discard_statement(entry, statement); napi_throw_range_error(env, "ERR_OUT_OF_RANGE", "SQLite result has too many rows"); return NULL;
    }
    row_count++;
  }
  if (rc != SQLITE_DONE && !(mode == 1 && rc == SQLITE_ROW)) { sqlite_failure(env, handle->db, rc); discard_statement(entry, statement); return NULL; }
  rc = release_statement(handle, entry, statement);
  if (rc != SQLITE_OK) return sqlite_failure(env, handle->db, rc);
  if (mode == 0) {
    napi_value changes, inserted;
    int64_t changed = sqlite3_changes64(handle->db), rowid = sqlite3_last_insert_rowid(handle->db);
    if (changed > MAX_SAFE_INTEGER || rowid > MAX_SAFE_INTEGER || rowid < -MAX_SAFE_INTEGER) {
      napi_throw_range_error(env, "ERR_OUT_OF_RANGE", "SQLite change receipt exceeds the JavaScript safe range"); return NULL;
    }
    if (!napi_okay(env, napi_create_object(env, &result)) ||
        !napi_okay(env, napi_create_double(env, (double)changed, &changes)) ||
        !napi_okay(env, napi_create_double(env, (double)rowid, &inserted)) ||
        !napi_okay(env, napi_set_named_property(env, result, "changes", changes)) ||
        !napi_okay(env, napi_set_named_property(env, result, "lastInsertRowid", inserted))) return NULL;
  }
  return result ? result : undefined_value(env);
}

static napi_value query_sql(napi_env env, napi_callback_info info) {
  size_t argc = 4, length = 0;
  napi_value args[4], result;
  char *sql = NULL;
  int32_t mode;
  if (!napi_okay(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL))) return NULL;
  if (argc != 4) { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "SQLite query requires database, SQL, bindings and mode"); return NULL; }
  garden_db *handle = database_value(env, args[0]);
  if (!handle || !string_value(env, args[1], &sql, &length, "SQLite SQL must be text")) return NULL;
  if (memchr(sql, 0, length)) { free(sql); napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "SQLite SQL cannot contain a NUL byte"); return NULL; }
  if (!napi_okay(env, napi_get_value_int32(env, args[3], &mode))) { free(sql); return NULL; }
  if (mode < 0 || mode > 2) { free(sql); napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "SQLite result mode is invalid"); return NULL; }
  // Named/array parameter access can invoke JS getters. Keep the external and
  // connection live, and prevent a getter from closing or mutating this handle
  // through a second query/exec while the original statement is being bound.
  handle->in_call = 1;
  result = execute_query(env, handle, sql, length, args[2], mode);
  handle->in_call = 0;
  return result;
}

static napi_value statement_cache_info(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1], result, value;
  if (!napi_okay(env, napi_get_cb_info(env, info, &argc, args, NULL, NULL))) return NULL;
  if (argc != 1) { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "SQLite cache status requires a database"); return NULL; }
  garden_db *handle = database_value(env, args[0]);
  if (!handle || !napi_okay(env, napi_create_object(env, &result))) return NULL;
  const char *names[] = {"entries","bytes","peakBytes","hits","misses","evictions","reprepares","entryLimit","byteLimit"};
  uint64_t values[] = {handle->statement_count,handle->statement_bytes,handle->peak_statement_bytes,
    handle->cache_hits,handle->cache_misses,handle->cache_evictions,handle->cache_reprepares,STATEMENT_CACHE_COUNT,STATEMENT_CACHE_BYTES};
  for (size_t i=0; i<sizeof(values)/sizeof(values[0]); i++) {
    if (!napi_okay(env,napi_create_double(env,(double)(values[i]>(uint64_t)MAX_SAFE_INTEGER?(uint64_t)MAX_SAFE_INTEGER:values[i]),&value)) ||
        !napi_okay(env,napi_set_named_property(env,result,names[i],value))) return NULL;
  }
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  uint32_t version;
  if (!napi_okay(env, napi_get_version(env, &version))) return NULL;
  if (version < 8) { napi_throw_error(env, "ERR_NATIVE_SQLITE_NAPI_VERSION", "Native SQLite requires Node-API 8"); return NULL; }
  napi_property_descriptor methods[] = {
    { .utf8name = "open", .method = open_database, .attributes = napi_default },
    { .utf8name = "close", .method = close_database, .attributes = napi_default },
    { .utf8name = "exec", .method = exec_sql, .attributes = napi_default },
    { .utf8name = "query", .method = query_sql, .attributes = napi_default },
    { .utf8name = "statementCacheInfo", .method = statement_cache_info, .attributes = napi_default },
  };
  if (!napi_okay(env, napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods))) return NULL;
  napi_value value;
  if (!napi_okay(env, napi_create_string_utf8(env, sqlite3_libversion(), NAPI_AUTO_LENGTH, &value)) ||
      !napi_okay(env, napi_set_named_property(env, exports, "sqliteVersion", value)) ||
      !napi_okay(env, napi_create_string_utf8(env, sqlite3_sourceid(), NAPI_AUTO_LENGTH, &value)) ||
      !napi_okay(env, napi_set_named_property(env, exports, "sqliteSourceId", value)) ||
      !napi_okay(env, napi_create_int32(env, 8, &value)) ||
      !napi_okay(env, napi_set_named_property(env, exports, "napiVersion", value))) return NULL;
  return exports;
}

NAPI_MODULE(garden_sqlite, initialize)
