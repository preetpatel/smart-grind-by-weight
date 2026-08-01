// Encoder/decoder compatibility test: a patch created by the *installed*
// Python detools (tools/tests/fixtures/make_patch_fixture.py, run by the test
// harness) must be decodable by the real C decoder shipped in firmware. This
// is the drift guard for the detools/heatshrink2 version pins - if either
// side changes patch format, this fails on the host instead of bricking
// updates in the field.
//
// TEST_INCLUDE_DIRS: components/detools/include components/detools/heatshrink

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../../components/detools/detools.c"
#include "../../components/detools/heatshrink/heatshrink_decoder.c"

#ifndef TEST_FIXTURE_DIR
#error "TEST_FIXTURE_DIR must be defined by the test harness"
#endif

// Mirrors the device-side callbacks in components/delta/delta.c: seekable
// source, streamed patch, appended destination.
struct ApplyContext {
    std::vector<unsigned char> source;
    std::vector<unsigned char> patch;
    std::vector<unsigned char> output;
    size_t src_offset = 0;
    size_t patch_offset = 0;
};

static int read_source(void* arg, uint8_t* buf, size_t size) {
    auto* ctx = static_cast<ApplyContext*>(arg);
    if (ctx->src_offset + size > ctx->source.size()) return -1;
    memcpy(buf, ctx->source.data() + ctx->src_offset, size);
    ctx->src_offset += size;
    return 0;
}

static int seek_source(void* arg, int offset) {
    auto* ctx = static_cast<ApplyContext*>(arg);
    long pos = (long)ctx->src_offset + offset;
    if (pos < 0 || (size_t)pos > ctx->source.size()) return -1;
    ctx->src_offset = (size_t)pos;
    return 0;
}

static int read_patch(void* arg, uint8_t* buf, size_t size) {
    auto* ctx = static_cast<ApplyContext*>(arg);
    if (ctx->patch_offset + size > ctx->patch.size()) return -1;
    memcpy(buf, ctx->patch.data() + ctx->patch_offset, size);
    ctx->patch_offset += size;
    return 0;
}

static int write_output(void* arg, const uint8_t* buf, size_t size) {
    auto* ctx = static_cast<ApplyContext*>(arg);
    ctx->output.insert(ctx->output.end(), buf, buf + size);
    return 0;
}

static bool read_file(const std::string& path, std::vector<unsigned char>& out) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return false;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    out.resize((size_t)size);
    bool ok = size >= 0 && fread(out.data(), 1, (size_t)size, f) == (size_t)size;
    fclose(f);
    return ok;
}

int main() {
    const std::string dir = TEST_FIXTURE_DIR;

    ApplyContext ctx;
    std::vector<unsigned char> expected;
    if (!read_file(dir + "/base.bin", ctx.source) ||
        !read_file(dir + "/target.bin", expected) ||
        !read_file(dir + "/patch.bin", ctx.patch)) {
        std::printf("FAIL: fixtures missing - make_patch_fixture.py did not run "
                    "(is detools==0.53.0 installed?)\n");
        return 1;
    }

    int result = detools_apply_patch_callbacks(read_source, seek_source, read_patch,
                                               ctx.patch.size(), write_output, &ctx);
    if (result < 0) {
        std::printf("FAIL: C decoder rejected the Python-generated patch: %s (%d)\n",
                    detools_error_as_string(result), result);
        return 1;
    }
    if ((size_t)result != expected.size() || ctx.output != expected) {
        std::printf("FAIL: reconstructed image differs (got %zu bytes, want %zu)\n",
                    ctx.output.size(), expected.size());
        return 1;
    }

    std::printf("patch compat ok: %zuB base + %zuB patch -> %zuB target, byte-identical\n",
                ctx.source.size(), ctx.patch.size(), expected.size());
    return 0;
}
