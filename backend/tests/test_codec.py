"""Tests for the CXN wire-protocol codec.

DATA-CONTRACT NOTE (see plan/notes.md): the byte fixtures below are hand-derived from the
documented CXN protocol (PyMeasure `tccxn.py`, MIT), NOT captured from our physical unit.
They verify that our codec is *spec-correct*. Before trusting the codec on real RF hardware,
a read-only capture must confirm the unit speaks this exact dialect.

All expected checksums are computed by hand from the spec (2-byte big-endian sum of the
message bytes) so the test does not merely mirror the implementation.
"""

import struct

import pytest

from tc_power_interface.protocol import codec


class TestChecksum:
    def test_checksum_is_big_endian_sum_of_bytes(self):
        # sum(b"C\x00GP\x00\x00\x00\x00") = 67+0+71+80 = 218 -> 0x00DA
        assert codec.checksum(b"C\x00GP\x00\x00\x00\x00") == b"\x00\xda"

    def test_checksum_wraps_into_two_bytes(self):
        # sum of four 0xFF = 1020 = 0x03FC
        assert codec.checksum(b"\xff\xff\xff\xff") == b"\x03\xfc"


class TestEncodeCommand:
    def test_wraps_six_byte_command_with_header_address_and_checksum(self):
        # power query GP\x00\x00\x00\x00 at address 0
        frame = codec.encode_command(b"GP\x00\x00\x00\x00")
        assert frame == b"C\x00GP\x00\x00\x00\x00\x00\xda"
        assert len(frame) == 10

    def test_honours_nonzero_address(self):
        frame = codec.encode_command(b"GP\x00\x00\x00\x00", address=2)
        # header 'C', address 2, then command, then checksum over first 8 bytes
        body = b"C\x02GP\x00\x00\x00\x00"
        assert frame == body + struct.pack(">H", sum(body))

    def test_rejects_command_not_six_bytes(self):
        with pytest.raises(ValueError):
            codec.encode_command(b"GP\x00\x00")  # too short


class TestDecodeResponse:
    def _power_response(self) -> bytes:
        data = b"\x05\xdc\x00\x14\x05\xc8"  # 1500, 20, 1480 -> 150.0, 2.0, 148.0 W
        header = b"R\x00" + struct.pack(">H", len(data))
        return header + data + struct.pack(">H", sum(header + data))

    def test_returns_data_field_for_valid_frame(self):
        assert codec.decode_response(self._power_response()) == b"\x05\xdc\x00\x14\x05\xc8"

    def test_rejects_bad_header_byte(self):
        frame = bytearray(self._power_response())
        frame[0] = ord("X")
        with pytest.raises(ValueError):
            codec.decode_response(bytes(frame))

    def test_rejects_wrong_address(self):
        with pytest.raises(ValueError):
            codec.decode_response(self._power_response(), address=1)

    def test_rejects_checksum_error(self):
        frame = bytearray(self._power_response())
        frame[-1] ^= 0xFF  # corrupt checksum
        with pytest.raises(ValueError):
            codec.decode_response(bytes(frame))


class TestParsers:
    def test_parse_power_returns_forward_reverse_load_watts(self):
        assert codec.parse_power(b"\x05\xdc\x00\x14\x05\xc8") == (150.0, 2.0, 148.0)

    def test_parse_status_decodes_intflag_bits(self):
        # RF on (bit0) + forward power limit (bit8) = 1 + 256 = 257
        status = codec.parse_status(struct.pack(">H", 257) + b"\x00" * 6)
        assert codec.Status.RF_ENABLED in status
        assert codec.Status.FORWARD_POWER_LIMIT in status
        assert codec.Status.OVER_TEMPERATURE not in status

    def test_parse_temperature_from_status_block_tenths_of_degree(self):
        # bytes [2:4] hold temperature in tenths of a degree C
        block = struct.pack(">H", 0) + struct.pack(">H", 425) + b"\x00" * 4
        assert codec.parse_temperature(block) == 42.5

    def test_parse_frequency_is_uint32_hz(self):
        assert codec.parse_frequency(struct.pack(">L", 13_560_000)) == 13_560_000


class TestCommandBuilders:
    def test_power_query_command(self):
        assert codec.cmd_power() == b"GP\x00\x00\x00\x00"

    def test_rf_enable_uses_0x55_pair_and_disable_uses_zero(self):
        assert codec.cmd_rf_enable(True) == b"BR\x55\x55\x00\x00"
        assert codec.cmd_rf_enable(False) == b"BR\x00\x00\x00\x00"

    def test_request_and_release_control_and_ping(self):
        assert codec.cmd_request_control() == b"BC\x55\x55\x00\x00"
        assert codec.cmd_release_control() == b"BC\x00\x00\x00\x00"
        assert codec.cmd_ping() == b"BP\x00\x00\x00\x00"

    def test_setpoint_encodes_watts_as_big_endian_u16(self):
        # 150 W -> 0x0096 in the two parameter-1 bytes
        assert codec.cmd_setpoint(150) == b"SA\x00\x96\x00\x00"

    def test_setpoint_rejects_out_of_range(self):
        with pytest.raises(ValueError):
            codec.cmd_setpoint(5000)  # max documented is 4000


class TestStatusBlockParsers:
    def _gs_block(self, status=1, temp_tenths=420, mode=1, tuner=3) -> bytes:
        return (
            struct.pack(">H", status)
            + struct.pack(">H", temp_tenths)
            + struct.pack(">H", mode)
            + struct.pack(">H", tuner)
        )

    def test_parse_operation_mode(self):
        assert codec.parse_operation_mode(self._gs_block(mode=1)) == "normal"
        assert codec.parse_operation_mode(self._gs_block(mode=3)) == "pulse"
        assert codec.parse_operation_mode(self._gs_block(mode=4)) == "ramp"

    def test_parse_tuner(self):
        assert codec.parse_tuner(self._gs_block(tuner=3)) == "analog tuner"
        assert codec.parse_tuner(self._gs_block(tuner=1)) == "none"


class TestGtBlock:
    def _gt_block(self, manual=1, load_t=550, tune_t=420, dcv=1234, preset=3) -> bytes:
        return (
            struct.pack(">H", manual)
            + struct.pack(">H", load_t)
            + struct.pack(">H", tune_t)
            + struct.pack(">H", dcv)
            + struct.pack(">H", preset)
        )

    def test_parse_gt_block_fields(self):
        gt = codec.parse_gt(self._gt_block())
        assert gt.manual_mode is True
        assert gt.load_capacity == 55.0
        assert gt.tune_capacity == 42.0
        assert gt.dc_voltage == 1234
        assert gt.preset_slot == 3

    def test_manual_mode_false_when_bit0_clear(self):
        assert codec.parse_gt(self._gt_block(manual=0)).manual_mode is False


class TestPowerLimitBlock:
    def test_parse_power_limit_and_reverse_limit(self):
        data = (
            struct.pack(">H", 0)
            + struct.pack(">H", 6000)  # [2:4] forward power limit -> 600.0 W
            + b"\x00" * 14
            + struct.pack(">H", 600)  # [18:20] reverse power limit -> 60.0 W
        )
        assert codec.parse_power_limit(data) == 600.0
        assert codec.parse_reverse_power_limit(data) == 60.0


class TestIdentifyParsers:
    def test_parse_id_string_strips_prefix_and_terminator(self):
        assert codec.parse_id_string(b"\x00\x00AG 0613 \x00") == "AG 0613"

    def test_parse_firmware(self):
        assert codec.parse_firmware(bytes([1, 2, 3, 4])) == {"ui": "1.2", "rf": "3.4"}


class TestMatchCommandBuilders:
    def test_identify_query_commands(self):
        assert codec.cmd_id() == b"Gi\x00\x01\x00\x00"
        assert codec.cmd_serial() == b"Gi\x00\x02\x00\x00"
        assert codec.cmd_firmware() == b"Gf\x00\x00\x00\x00"
        assert codec.cmd_frequency() == b"GF\x00\x00\x00\x00"
        assert codec.cmd_power_limit() == b"Gp\x00\x00\x00\x00"
        assert codec.cmd_gt() == b"GT\x00\x00\x00\x00"

    def test_manual_mode_command_is_manual_only(self):
        # SAFETY: only the manual (TM 02) command exists; no automatic (TM 01) path.
        assert codec.cmd_manual_mode() == b"TM\x00\x02\x00\x00"

    def test_capacity_commands(self):
        # 0.1% resolution: value field is round(percent * 10) as a 2-byte big-endian int.
        assert codec.cmd_load_capacity(55) == b"TC\x00\x01" + (550).to_bytes(2, "big")
        assert codec.cmd_tune_capacity(42) == b"TC\x00\x02" + (420).to_bytes(2, "big")
        assert codec.cmd_tune_capacity(42.5) == b"TC\x00\x02" + (425).to_bytes(2, "big")

    def test_capacity_rejects_out_of_range(self):
        with pytest.raises(ValueError):
            codec.cmd_load_capacity(150)
        with pytest.raises(ValueError):
            codec.cmd_tune_capacity(-1)
