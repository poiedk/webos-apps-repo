#include <fcntl.h>
#include <unistd.h>

struct auxv_entry {
    unsigned long type;
    unsigned long value;
};

unsigned long getauxval(unsigned long type) {
    int fd = open("/proc/self/auxv", O_RDONLY);
    struct auxv_entry entry;

    if (fd < 0) {
        return 0;
    }

    while (read(fd, &entry, sizeof(entry)) == (ssize_t)sizeof(entry)) {
        if (entry.type == type) {
            close(fd);
            return entry.value;
        }
        if (entry.type == 0) {
            break;
        }
    }

    close(fd);
    return 0;
}
