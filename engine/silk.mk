# Portable SDK library only: no ARM assembly and no converter/test programs.
sources := $(wildcard $(SILK_SOURCE)/silk/src/*.c)
objects := $(patsubst $(SILK_SOURCE)/silk/src/%.c,$(SILK_OBJECTS)/%.o,$(sources))
library := $(SILK_OBJECTS)/libSKP_SILK_SDK.a
.PHONY: all
all: $(library)
$(SILK_OBJECTS)/%.o: $(SILK_SOURCE)/silk/src/%.c
	$(CC) $(CFLAGS) -O2 -fPIC -std=c99 -fwrapv -fno-strict-aliasing -I$(SILK_SOURCE)/silk/interface -I$(SILK_SOURCE)/silk/src -c $< -o $@
$(library): $(objects)
	$(AR) rcs $@ $^
	$(RANLIB) $@
